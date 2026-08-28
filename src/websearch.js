// `web_search` custom tool — queries Exa AI's hosted MCP endpoint AND (when
// configured) a searxng instance, then merges + de-duplicates the hits into a
// single Exa-shaped text block so small models keep parsing one stable format.
//
// Two reasons for the custom-tool route over `config.mcp.exa`:
//   1. MCP-server-supplied tool descriptions (~1.5 KB) would land in every LLM
//      call's system prompt; we control a short description here instead.
//   2. opencode also ships a gated built-in tool literally called `websearch`
//      — registering a plugin tool of the same name collides and opencode
//      ends up exposing neither. We pick `web_search` (snake case) to dodge
//      that.
//
// The transports (Exa, searxng) and the parse/merge/render helpers live in
// `searchcore.js`; `forum_search` uses the same core. searxng is enabled only
// when a base URL is configured (settings `searxngUrl` > env
// OPENCODE_AGENT_INTERCOM_SEARXNG_URL); unset → Exa-only.
// Disable the whole tool with OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH=1.

import { tool } from "@opencode-ai/plugin"
import { log } from "./log.js"
import {
  runSearchLegs,
  legFailureText,
  parseExaEntries,
  searxToEntries,
  mergeAndDedup,
  renderEntries,
} from "./searchcore.js"

const z = tool.schema

export function isWebsearchEnabled() {
  return process.env.OPENCODE_AGENT_INTERCOM_DISABLE_WEBSEARCH !== "1"
}

export function createWebsearchTool() {
  return tool({
    description:
      "Web search (Exa AI + searxng). Returns the top hits as clean text with title, URL, " +
      "publish date and content excerpt — usually enough to answer without a follow-up fetch. " +
      'Phrase the query as a description of the ideal page, not keywords ("blog post comparing ' +
      'X and Y performance" beats "X vs Y"). Use webfetch on a returned URL for the full page.',
    args: {
      query: z
        .string()
        .min(1)
        .describe("Natural-language description of the ideal page (not just keywords)"),
      numResults: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("How many hits to return, default 5"),
    },
    execute: async (args) => {
      const numResults = args.numResults ?? 5

      const { exaText, exaErr, searxRows, searxErr } = await runSearchLegs({
        label: "websearch",
        exaArgs: { query: args.query, numResults },
        searxQuery: args.query,
      })

      const exaEntries = parseExaEntries(exaText)
      const searxEntries = searxToEntries(searxRows)

      // Both backends dead → historic error-output shape, no crash.
      if (exaEntries.length === 0 && searxEntries.length === 0) {
        return { output: legFailureText("websearch", exaErr, searxErr) }
      }

      const { merged, duplicates } = mergeAndDedup(exaEntries, searxEntries)
      const capped = merged.slice(0, numResults)
      log(
        "websearch merge",
        `exa=${exaEntries.length}`,
        `searxng=${searxEntries.length}`,
        `merged=${merged.length}`,
        `dupesRemoved=${duplicates}`,
        `returned=${capped.length}`,
      )
      return { output: renderEntries(capped) }
    },
  })
}
