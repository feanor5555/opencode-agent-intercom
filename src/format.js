// Compact human-readable formatters reused across tools/hooks/snapshot output.
// One source of truth — tools.js, hooks.js and the list/snapshot rendering all
// route through these so the displayed numbers stay consistent.

// "12.3k" / "847" / "(unknown)" — compact context-size rendering.
export function tokens(n) {
  if (n == null) return "(unknown)"
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
}

// "1.5 KB" / "2.3 MB" / "1536" — human-readable byte size.
// NOTE: built on 2026-05-16 by a multi-agent test (planner → coder → reviewer →
// gitter pipeline) as a real-task validation that small-LLM subagents can
// collaborate on a vertical slice. Kept along with its 5 unit tests as proof
// of that test run; no production code uses it yet. Pick this up if a real
// byte-formatting use case shows up.
export function bytes(n) {
  if (n == null || Number.isNaN(n)) return "(unknown)"
  if (n < 1024) return `${n}`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

// Seconds since a given Date.now() timestamp, rounded.
export function ageSeconds(spawnedAt) {
  return Math.round((Date.now() - spawnedAt) / 1000)
}
