// The thread shape: `isThreadUrl(url)`, a pure function over the URL alone.
// `forum_search` reads it to ORDER its two lanes and to bound how many
// non-thread rows the searxng lane may contribute — never to drop a row.
//
// Every shape below names a URL form, not a community: no domain list, no
// whitelist. That is the point. A curated list of named forums matches only
// what someone thought to enumerate — measured against 20 forum hits, exactly
// one was on such a list, while the vendor forums and Discourse instances that
// carried the rest could never have been on it. A path segment `/viewtopic.php`
// or `/questions/`, or a host label `forum`, is carried by hosts no list
// reaches.
//
// The rule is deliberately incomplete: a Lemmy or Discourse instance with an
// unusual path shape reads as a non-thread here. That costs it order, never
// presence.

// Host labels that mark a discussion site on their own, plus any label that
// begins `forum` (`forum`, `forums`, `forum-de`, …).
const FORUM_HOST_LABELS = new Set([
  "forum",
  "forums",
  "board",
  "boards",
  "community",
  "discuss",
  "discussion",
  "answers",
])

// Path segments that mark a thread wherever in the path they appear: the three
// classic board scripts, the thread/topic/forum segments, and reddit's
// `/comments/`.
const THREAD_SEGMENTS = new Set([
  "viewtopic.php",
  "showthread.php",
  "viewthread.php",
  "thread",
  "threads",
  "topic",
  "topics",
  "forum",
  "forums",
  "comments",
])

// Segments that mark a thread only with an id or slug behind them: Discourse's
// `/t/<id>` and Stack Exchange's long form `/questions/<id>`. The bare segment
// is a listing page, not a thread.
const SLUG_ID_SEGMENTS = new Set(["t", "questions"])

// Segments that mark a thread only with a NUMERIC id behind them: Stack
// Exchange's short forms and the issue trackers. `/issues` alone is the issue
// list of a repository; `/issues/7` is one discussion.
const NUMERIC_ID_SEGMENTS = new Set(["q", "a", "issues", "discussions"])

// Parse a URL that may arrive without a scheme (searxng and Exa both return
// absolute URLs, but neither is a contract). Garbage returns null.
function parseUrl(raw) {
  if (!raw || typeof raw !== "string") return null
  const s = raw.trim()
  if (!s) return null
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    return null
  }
}

export function isThreadUrl(url) {
  const parsed = parseUrl(url)
  if (!parsed) return false

  const labels = parsed.hostname.toLowerCase().split(".")
  if (labels.some((l) => FORUM_HOST_LABELS.has(l) || l.startsWith("forum"))) return true

  const segments = parsed.pathname.split("/").filter(Boolean).map((s) => s.toLowerCase())
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const next = segments[i + 1]
    if (THREAD_SEGMENTS.has(seg)) return true
    if (SLUG_ID_SEGMENTS.has(seg) && next !== undefined) return true
    if (NUMERIC_ID_SEGMENTS.has(seg) && next !== undefined && /^\d+$/.test(next)) return true
  }

  // Hacker News: the discussion page is `/item?id=<digits>` — the only shape
  // here that needs the query string.
  if (segments[segments.length - 1] === "item") {
    return /^\d+$/.test(parsed.searchParams.get("id") ?? "")
  }
  return false
}
