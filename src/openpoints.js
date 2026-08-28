// The parser for the orchestrator's final "what is still open" turn in an
// endless cycle. Pure: one string in, a task list out — no I/O, no plugin
// runtime, no imports.
//
// The reply the prompt asks for (OPEN_POINTS_PROMPT in handoff.js) is the todo
// file's own two-line shape, so the parse maps straight onto
// `addTask({ title, accept })`:
//
//   ## OPEN POINTS
//
//   - <one open point, imperative>
//     accept: <one line naming what would show it is done>
//   - <the next one>
//
// The heading is what tells "the orchestrator answered" from "the orchestrator
// answered something else": a reply without it yields `null` and the cycle
// abandons, a reply with it and no points yields `[]` — a legal answer that
// means there is nothing left to save.

// Recognises the heading the prompt demands. /m so a model that prepends prose
// still matches on the heading's own line — that prose is then ignored, the
// parse starts after the heading.
const HEADING_RE = /^##\s+OPEN POINTS\s*$/m

// `- <title>` at the start of a line, with optional leading indent.
const POINT_LINE_RE = /^\s*-\s+(.*)$/

// The criterion line belonging to the point above it. Indented, per the todo
// file's own format.
const ACCEPT_LINE_RE = /^\s+accept:\s*(.*)$/i

// Per-field cap. Both fields land in a todo file a human reads and an
// orchestrator plans from; a runaway line would make both unusable.
export const OPEN_POINT_MAX_CHARS = 200

// Cap on the list. Forty points is already far more than one cycle's worth of
// open work; beyond it the reply is a dump, not a hand-over.
export const OPEN_POINTS_MAX = 40

// Parses the orchestrator's open-points reply.
//
// @param {string} rawText the reply as it came back from the session
// @returns {Array<{ title: string, accept?: string }>|null} the points in
//   reply order, or null when the reply carries no `## OPEN POINTS` heading
export function parseOpenPoints(rawText) {
  if (typeof rawText !== "string") return null
  const heading = HEADING_RE.exec(rawText)
  if (!heading) return null

  const body = rawText.slice(heading.index + heading[0].length)
  const lines = body.split("\n")
  const points = []
  for (let i = 0; i < lines.length && points.length < OPEN_POINTS_MAX; i++) {
    const m = POINT_LINE_RE.exec(lines[i])
    if (!m) continue
    const title = capChars(m[1].trim(), OPEN_POINT_MAX_CHARS)
    // A bullet with nothing on it is not a point.
    if (!title) continue
    const point = { title }
    const am = i + 1 < lines.length ? ACCEPT_LINE_RE.exec(lines[i + 1]) : null
    if (am) {
      const accept = capChars(am[1].trim(), OPEN_POINT_MAX_CHARS)
      // The criterion is optional — an `accept:` line with nothing after it
      // is the same as none at all.
      if (accept) point.accept = accept
      i += 1
    }
    points.push(point)
  }
  return points
}

function capChars(text, max) {
  if (text.length <= max) return text
  return text.slice(0, max - 1).replace(/\s+$/, "") + "…"
}
