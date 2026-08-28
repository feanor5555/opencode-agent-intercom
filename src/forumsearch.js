// `forum_search` custom tool — the forum route beside `web_search`. Same two
// backends and the same rendered text shape, but each leg is aimed at threads
// instead of pages:
//   - Exa gets an envelope query ("forum threads where people report their real
//     experience with …"). The endpoint's `web_search_exa` takes a query and a
//     count and nothing else — no domain parameter exists, and one sent anyway
//     is silently ignored rather than rejected — so the envelope prose is the
//     only steer this leg has. It is over-fetched (numResults * 2, capped at
//     the endpoint's 20) so the interleave has material left after dedup.
//   - searxng gets the bare user query behind a chain of engine bangs. Those
//     engines search nothing but forums and Q&A sites, so on this route the
//     bangs ARE the domain restriction. Bangs reach an engine even when the
//     instance has it disabled; one the instance does not know simply returns
//     nothing.
//
// Nothing filters. No whitelist, no host matching, no partition: each backend's
// own ranking stands, and the only reordering is the round-robin interleave
// that keeps the loud leg (searxng answers 80-90 rows) from burying the quiet
// one (Exa's 20, and the only leg that reaches reddit, Discourse and vendor
// forums). The one drop is the relative score cut inside the searxng leg's own
// ranking, before the legs meet.
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

// Rows scoring below this fraction of the response's top score are dropped
// inside the searxng leg. Relative, because searxng's absolute score level
// depends on how many engines answered.
const SCORE_CUT_RATIO = 0.1

// The Exa leg's query: the measured prefix plus the user's query verbatim.
export function forumEnvelope(query) {
  return `${EXA_ENVELOPE_PREFIX} ${query}`
}

// The searxng leg's query: the bangs, then the BARE user query. The envelope
// prose stays out — these engines are keyword search over their own site-local
// indexes, where the extra words match nothing.
export function bangQuery(query, bangs) {
  return `${bangs.join(" ")} ${query}`
}

// Rank the searxng entries by searxng's own score and drop the tail below
// SCORE_CUT_RATIO of the top score. An entry exactly at the threshold stays.
// An all-zero response (no engine supplied a score) has threshold 0 and keeps
// everything rather than discarding the leg.
export function cutByScore(entries) {
  const ranked = [...entries].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const top = ranked.length > 0 ? ranked[0].score ?? 0 : 0
  const threshold = top * SCORE_CUT_RATIO
  return ranked.filter((e) => (e.score ?? 0) >= threshold)
}

// The searxng lane as it enters the merge: cut inside searxng's own ranking,
// then bounded to `limit` rows so an 80-90-row response cannot carry its tail
// into the merge. The bound cannot change the rendered count — the interleave
// caps at numResults either way — so it is checked as a pure function.
export function cutSearxLeg(entries, limit) {
  return cutByScore(entries).slice(0, limit)
}

// Round-robin the two legs, `primary` first, each keeping its own rank order,
// up to `limit` entries. Concatenation would bury the shorter leg; this starves
// neither and drops nothing that fits.
export function interleave(primary, secondary, limit) {
  const out = []
  const rounds = Math.max(primary.length, secondary.length)
  for (let i = 0; i < rounds && out.length < limit; i++) {
    if (i < primary.length) out.push(primary[i])
    if (out.length < limit && i < secondary.length) out.push(secondary[i])
  }
  return out
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

      // One Exa call per invocation — the free tier's rate limit is tight.
      const { exaText, exaErr, searxRows, searxErr } = await runSearchLegs({
        label: "forumsearch",
        exaArgs: {
          query: forumEnvelope(args.query),
          numResults: Math.min(MAX_EXA_RESULTS, numResults * 2),
        },
        searxQuery: bangQuery(args.query, getForumBangs()),
      })

      const exaEntries = parseExaEntries(exaText)
      const searxRaw = searxToEntries(searxRows)
      const searxEntries = cutSearxLeg(searxRaw, numResults * 2)

      // Both legs dead → the error-output shape web_search uses, no crash.
      if (exaEntries.length === 0 && searxEntries.length === 0) {
        return { output: legFailureText("forum_search", exaErr, searxErr) }
      }

      // A URL both legs surfaced keeps its first-seen leg and both `sources`,
      // so it interleaves in the Exa lane and still reports the confirmation.
      const { merged, duplicates } = mergeAndDedup(exaEntries, searxEntries)
      const picked = interleave(
        merged.filter((e) => e.source === "exa"),
        merged.filter((e) => e.source !== "exa"),
        numResults,
      )
      log(
        "forumsearch merge",
        `exa=${exaEntries.length}`,
        // kept over raw, so a score cut that swallowed the leg is visible
        `searxng=${searxEntries.length}/${searxRaw.length}`,
        `merged=${merged.length}`,
        `dupesRemoved=${duplicates}`,
        `returned=${picked.length}`,
      )
      return { output: renderEntries(picked) }
    },
  })
}
