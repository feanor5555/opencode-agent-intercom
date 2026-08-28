// `forum_search` custom tool — the forum route beside `web_search`. Same two
// backends and the same rendered text shape, but each leg is aimed at threads
// instead of pages, and each is sent the query form it answers to:
//   - Exa gets an envelope query ("forum threads where people report their real
//     experience with …"). The endpoint's `web_search_exa` takes a query and a
//     count and nothing else — no domain parameter exists, and one sent anyway
//     is silently ignored rather than rejected — so the envelope prose is the
//     only steer this leg has. It is over-fetched (numResults * 2, capped at
//     the endpoint's 20) so the merge has material left after dedup.
//   - searxng gets two to four bare topic words behind a chain of engine bangs:
//     the model's own `keywords` when it supplied them, `reduceToKeywords(query)`
//     otherwise. These engines are keyword search over site-local indexes and
//     narrow hard on every added word — prose costs the thread engines every row
//     they have. The engines search nothing but forums and Q&A sites, so on this
//     route the bangs ARE the domain restriction. A bang reaches an engine even
//     where the instance disabled it; one the instance does not know simply
//     returns nothing.
//
// Nothing is dropped for being off a list: no whitelist, no curated domains, no
// partition by community. The thread shape of `threadshape.js` ORDERS rows
// inside a lane and bounds how many non-thread rows the searxng lane may
// contribute — it never removes one, and a row a quota skipped comes back in
// the fill step rather than shortening the output. The searxng lane's own cap
// is per engine (`MAX_ROWS_PER_ENGINE`), which is what stops the one loose
// matcher in the chain from owning the lane; searxng's `score` is a reciprocal
// rank and orders rows, it cannot express relevance, so nothing thresholds on
// it.
//
// `site:` is not used: a general engine has to honour it and on a typical
// instance those engines are the suspended ones. Categories are not used
// either — the bangs reach the same engines without a category name having to
// survive URL encoding.
//
// Excerpts are triage material: no page is fetched here, `webfetch` reads the
// threads worth reading.
// Disable the whole tool with OPENCODE_AGENT_INTERCOM_DISABLE_FORUM_SEARCH=1.

import { tool } from "@opencode-ai/plugin"
import { log } from "./log.js"
import { getForumBangs } from "./settings.js"
import { isThreadUrl } from "./threadshape.js"
import {
  runSearchLegs,
  legFailureText,
  parseExaEntries,
  searxToEntries,
  mergeAndDedup,
  renderEntries,
} from "./searchcore.js"

const z = tool.schema

// The Exa envelope. The prefix is the measured string: with the topic appended
// it returned 17 forum threads in 20 hits. No domain name goes in it — naming
// domains steers the neural ranking hard, so a couple of them would bias every
// question and twenty would dilute the steer entirely.
const EXA_ENVELOPE_PREFIX = "forum threads where people report their real experience with"

// `web_search_exa` returns 20 for numResults: 20; above that is untested.
const MAX_EXA_RESULTS = 20

// The searxng leg's ceiling on topic words: measured, three topic words answer
// from five engines, five words including one non-topical one cost the Stack
// Exchange engines four fifths of their rows.
const MAX_KEYWORDS = 4

// At most this many rows per engine reach the merge. This is what stops one
// loose matcher from filling the lane: measured, a single engine held 30 rows
// of a 73-row response, and 4 of 4 in a thin one.
const MAX_ROWS_PER_ENGINE = 2

// The searxng lane may spend at most `numResults / this` of the output on rows
// the shape does not call threads. The Exa lane has no such bound: its
// non-thread rows were measured on topic, while searxng's came from the engine
// whose URLs are submissions rather than discussions.
const SEARXNG_NON_THREAD_DIVISOR = 4

// Closed-class words and interrogatives: they name no topic, and every one of
// them narrows a site-local keyword index for nothing.
const STOPWORDS = new Set([
  "a", "about", "after", "all", "am", "an", "and", "any", "are", "as", "at", "be", "been", "being",
  "before", "but", "by", "can", "could", "did", "do", "does", "doing", "done", "for", "from", "had",
  "has", "have", "he", "her", "here", "his", "how", "i", "if", "in", "into", "is", "it", "its",
  "like", "may", "me", "might", "more", "most", "much", "must", "my", "no", "not", "of", "on",
  "onto", "or", "our", "out", "over", "shall", "she", "should", "so", "some", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "those", "to", "under", "up", "us",
  "very", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "whose",
  "why", "will", "with", "would", "you", "your",
])

// The route's own experience vocabulary — the same closed set the Exa envelope
// puts INTO its query and the researcher prompt uses to recognise the question.
// They say what is being asked about the topic, never what the topic is, and
// one of them ("practice") was measured to cost the thread engines four fifths
// of their rows. One vocabulary, used in the direction each leg needs.
const EXPERIENCE_WORDS = new Set([
  "actually", "advice", "anyone", "break", "breaks", "broken", "experience", "people", "practice",
  "real", "recommend", "report", "reports", "run", "running", "works", "working", "worth",
])

// The Exa leg's query: the measured prefix plus the user's query verbatim.
export function forumEnvelope(query) {
  return `${EXA_ENVELOPE_PREFIX} ${query}`
}

// Derive the searxng leg's query words from the prose question, for the case
// where the model omitted `keywords`. Case is left alone; punctuation is
// stripped at the token edges; the stopwords and the route's own experience
// vocabulary go; the first MAX_KEYWORDS survivors are kept in their original
// order. A question of nothing but those words falls back to the bare query —
// a thin searxng leg beats an empty one.
export function reduceToKeywords(query) {
  const text = String(query ?? "")
  const kept = text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t !== "")
    .filter((t) => {
      const word = t.toLowerCase()
      return !STOPWORDS.has(word) && !EXPERIENCE_WORDS.has(word)
    })
  if (kept.length === 0) return text.trim()
  return kept.slice(0, MAX_KEYWORDS).join(" ")
}

// The searxng leg's query: the bangs, then the topic words. The envelope prose
// stays out — these engines are keyword search over their own site-local
// indexes, where the extra words match nothing.
export function bangQuery(keywords, bangs) {
  return `${bangs.join(" ")} ${keywords}`
}

// The searxng lane as it enters the merge, in three operations, none of them a
// relevance filter:
//   1. order by searxng's score descending, ties in arrival order — the score
//      is a reciprocal rank, so this is every engine's rank-1 row first, then
//      every rank-2 row, and so on;
//   2. cap each engine at MAX_ROWS_PER_ENGINE of its own highest-ranked rows,
//      so every engine that answered is represented and none owns the lane;
//   3. truncate to `limit`.
// A row naming no engine is no evidence of a loud one, so it takes no shared
// bucket: a response without the field keeps all its rows.
export function searxLane(entries, limit) {
  const ranked = [...entries].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const perEngine = new Map()
  const lane = []
  for (const entry of ranked) {
    if (lane.length >= limit) break
    const engine = (entry.engine ?? "").trim()
    if (engine) {
      const taken = perEngine.get(engine) ?? 0
      if (taken >= MAX_ROWS_PER_ENGINE) continue
      perEngine.set(engine, taken + 1)
    }
    lane.push(entry)
  }
  return lane
}

// Stably partition one lane's rows so the thread-shaped ones lead, each group
// keeping the lane's own order. Nothing is removed: shape orders, never gates.
export function partitionByShape(entries) {
  const threads = []
  const rest = []
  for (const entry of entries) (isThreadUrl(entry.url) ? threads : rest).push(entry)
  return [...threads, ...rest]
}

// Pick up to `limit` rows out of the merged list. The two lanes — Exa first,
// its ordering being the measured one — are partitioned by shape and then taken
// round-robin, so a loud leg cannot bury a quiet one. A lane whose next row is
// a non-thread and whose non-thread quota is spent is skipped for that round;
// since the partition puts every thread first, such a lane is done contributing
// by turn. Whatever the quota held back then fills the output in merged order:
// the quota bounds a weak leg's SHARE, never the tool's yield.
export function pickFromLanes(merged, limit) {
  const lanes = [
    { rows: partitionByShape(merged.filter((e) => e.source === "exa")), next: 0, quota: Infinity },
    {
      rows: partitionByShape(merged.filter((e) => e.source !== "exa")),
      next: 0,
      quota: Math.floor(limit / SEARXNG_NON_THREAD_DIVISOR),
    },
  ]

  const picked = []
  const taken = new Set()
  let advanced = true
  while (picked.length < limit && advanced) {
    advanced = false
    for (const lane of lanes) {
      if (picked.length >= limit) break
      if (lane.next >= lane.rows.length) continue
      const entry = lane.rows[lane.next]
      if (!isThreadUrl(entry.url)) {
        if (lane.quota <= 0) continue
        lane.quota--
      }
      lane.next++
      picked.push(entry)
      taken.add(entry)
      advanced = true
    }
  }

  if (picked.length < limit) {
    for (const entry of merged) {
      if (picked.length >= limit) break
      if (!taken.has(entry)) picked.push(entry)
    }
  }
  return picked
}

// `<threads>/<returned>` for one lane of the picked rows — the per-lane figure
// the log line carries, so the Exa leg's thread yield is a property of every
// run rather than of someone remembering to look.
function threadCount(picked, source) {
  const rows = picked.filter((e) => (source === "exa" ? e.source === "exa" : e.source !== "exa"))
  return `${rows.filter((e) => isThreadUrl(e.url)).length}/${rows.length}`
}

export function isForumSearchEnabled() {
  return process.env.OPENCODE_AGENT_INTERCOM_DISABLE_FORUM_SEARCH !== "1"
}

export function createForumSearchTool() {
  return tool({
    description:
      "Search discussion forums and Q&A sites for lived user experience — whether a thing works " +
      "in practice, which settings people actually run, what breaks on them. Use this INSTEAD OF " +
      "`web_search` when the answer has to come from people who ran the thing; use `web_search` " +
      "for documentation, releases, versions and official facts. Returns threads as title, URL " +
      "and excerpt — triage material, then `webfetch` the ones worth reading.",
    args: {
      query: z
        .string()
        .min(1)
        .describe(
          "What experience you are looking for, in prose — the thing, plus what people would " +
            "be reporting about it",
        ),
      keywords: z
        .string()
        .optional()
        .describe(
          "The 2-4 bare topic words behind the question — no question words, no experience " +
            "words. Example: kubernetes raspberry pi",
        ),
      numResults: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("How many threads to return, default 8"),
    },
    execute: async (args) => {
      const numResults = args.numResults ?? 8
      // The model that wrote the question knows which of its words are the
      // topic; the derivation is the fallback for when it did not say.
      const keywords = args.keywords?.trim() || reduceToKeywords(args.query)

      // One Exa call per invocation — the free tier's rate limit is tight.
      const { exaText, exaErr, searxRows, searxErr } = await runSearchLegs({
        label: "forumsearch",
        exaArgs: {
          query: forumEnvelope(args.query),
          numResults: Math.min(MAX_EXA_RESULTS, numResults * 2),
        },
        searxQuery: bangQuery(keywords, getForumBangs()),
      })

      const exaEntries = parseExaEntries(exaText)
      const searxRaw = searxToEntries(searxRows)
      const searxEntries = searxLane(searxRaw, numResults)

      // Both legs dead → the error-output shape web_search uses, no crash.
      if (exaEntries.length === 0 && searxEntries.length === 0) {
        return { output: legFailureText("forum_search", exaErr, searxErr) }
      }

      // A URL both legs surfaced keeps its first-seen leg and both `sources`,
      // so it rides in the Exa lane and still reports the confirmation.
      const { merged, duplicates } = mergeAndDedup(exaEntries, searxEntries)
      const picked = pickFromLanes(merged, numResults)
      log(
        "forumsearch merge",
        `exa=${exaEntries.length}`,
        // kept over raw, so a lane the per-engine cap trimmed hard is visible
        `searxng=${searxEntries.length}/${searxRaw.length}`,
        `merged=${merged.length}`,
        `dupesRemoved=${duplicates}`,
        `returned=${picked.length}`,
        `threads=exa ${threadCount(picked, "exa")}`,
        `searxng ${threadCount(picked, "searxng")}`,
      )
      return { output: renderEntries(picked) }
    },
  })
}
