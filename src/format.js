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
