// Compact human-readable formatters reused across tools/hooks/snapshot output.
// One source of truth — tools.js, hooks.js and the list/snapshot rendering all
// route through these so the displayed numbers stay consistent.

// "12.3k" / "847" / "(unknown)" — compact context-size rendering.
export function tokens(n) {
  if (n == null) return "(unknown)"
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

// Rough token count of a text block: characters divided by four. An ESTIMATE,
// not a tokenizer — no tokenizer runs in-process. It is accurate to within
// tens of percent, which is all a gate set at fifths of a context budget
// needs. One source of truth: every size figure the plugin reports for a text
// it has in hand comes from here.
export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(String(text).length / 4)
}

// "40%" — a share of a context budget, rendered for prompts and notices.
export function percent(share) {
  return `${Math.round(share * 100)}%`
}

// Seconds since a given Date.now() timestamp, rounded.
export function ageSeconds(spawnedAt) {
  return Math.round((Date.now() - spawnedAt) / 1000)
}

// Whole minutes left on a retained subagent's window, floored at 0. Coarse on
// purpose: the figure is read by a model deciding whether a follow-up is still
// worth asking, and a second-precision countdown would be a number that moves
// on every render for no decision it changes. One source for both renderings —
// the `list` tool's retained section and the per-turn snapshot block.
export function retainedMinutesLeft(entry, ttlMs, now = Date.now()) {
  const left = (entry.retainedAt ?? 0) + ttlMs - now
  return Math.max(0, Math.floor(left / 60000))
}

// Conservative token estimate for text that is about to be pushed into another
// agent's context. ASCII at 3.5 chars per token, one token per non-ASCII code
// point. Overestimates plain English by ~14 %, sits within ~10 % of source
// code, JSON and paths, and no longer underestimates CJK and emoji by a factor
// of three the way chars/4 does. Overestimating is the safe direction here: it
// cuts earlier, and everything cut is kept in the overflow file.
//
// Beside estimateTokens, never over the same text: that one measures context
// budgets and work-package sizes at fifths of a budget, this one measures a
// reply against a token ceiling.
export function estimateReplyTokens(text) {
  if (!text) return 0
  let ascii = 0
  let wide = 0
  for (const ch of String(text)) {
    if (ch.codePointAt(0) < 128) ascii++
    else wide++
  }
  return Math.ceil(ascii / 3.5) + wide
}

// Cuts `text` to a prefix whose own estimateReplyTokens value is at or under
// `ceiling`, and reports how many estimated tokens fell away. Returns
// `{ kept, omittedTokens }`; `omittedTokens` is 0 exactly when nothing was cut.
//
// The walk is over CODE POINTS and charges each one the cost the estimator
// itself charges it, so the kept prefix is provably at or under the ceiling —
// no second unit, no character backstop, and no surrogate pair split in half.
//
// `ceiling <= 0` means no ceiling: the whole text comes back uncut. That is the
// `0` the settings surface documents for `resultTokens`.
export function cutToTokens(text, ceiling) {
  const s = text == null ? "" : String(text)
  if (s === "" || !(ceiling > 0)) return { kept: s, omittedTokens: 0 }
  const total = estimateReplyTokens(s)
  if (total <= ceiling) return { kept: s, omittedTokens: 0 }
  let ascii = 0
  let wide = 0
  let end = 0
  for (const ch of s) {
    const isAscii = ch.codePointAt(0) < 128
    const nextAscii = ascii + (isAscii ? 1 : 0)
    const nextWide = wide + (isAscii ? 0 : 1)
    if (Math.ceil(nextAscii / 3.5) + nextWide > ceiling) break
    ascii = nextAscii
    wide = nextWide
    end += ch.length
  }
  const kept = s.slice(0, end)
  return { kept, omittedTokens: total - estimateReplyTokens(kept) }
}
