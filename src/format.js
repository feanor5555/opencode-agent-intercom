// Compact human-readable formatters reused across tools/hooks/snapshot output.
// One source of truth — tools.js, hooks.js and the list/snapshot rendering all
// route through these so the displayed numbers stay consistent.

// "12.3k" / "847" / "(unknown)" — compact context-size rendering.
export function tokens(n) {
  if (n == null) return "(unknown)"
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

// Seconds since a given Date.now() timestamp, rounded.
export function ageSeconds(spawnedAt) {
  return Math.round((Date.now() - spawnedAt) / 1000)
}
