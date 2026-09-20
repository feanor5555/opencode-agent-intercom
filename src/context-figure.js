// The context figure of a session — ONE computation, shared by both halves of
// this plugin: the server side reaches it through `fetchSnapshot`
// (`src/client.js`), which feeds `entry.ctxTokens`, the primary threshold, the
// three subagent context bands, the reuse gates, the notices and the `list`
// column; the sidebar imports it directly (`tui/src/tui.tsx`) for the `<k> ctx`
// line on each row. The dependency-free module is what lets the TUI bundle
// (tsup, bundled separately from `src/`) carry the same code rather than
// re-declare it, so panel row and wake notice cannot disagree.
//
// The sum is the figure opencode shows the user — the five fields of one
// assistant message, `input + output + reasoning + cache.read + cache.write`:
// opencode's own surfaces (prompt bar, sidebar context indicator, status line)
// each compute exactly this sum, so every threshold of this plugin —
// `endlessContext` / `maxPrimaryContext`, a subagent's `contextBudgetFor`, the
// reuse ceilings — crosses at the moment the user's context display says it
// has. cache.read and cache.write are SEPARATE from input — the stored
// `tokens.input` is the noCache portion, so input + cache.read + cache.write is
// the total input. reasoning tokens are generated output rather than retained
// history, so this figure is larger than the session's true context fill on a
// thinking model — but the user's reading of "the threshold is reached" is the
// one that decides, so a threshold that fires early on a reasoning-heavy model
// is raised; the measure is not cut. (opencode's internal compaction/overflow
// guard is a DIFFERENT sum — it prefers `tokens.total`, excludes reasoning,
// and compares against a reserved ceiling; it guards the provider's window,
// not the displayed one, and is deliberately not copied here.)
//
// The SELECTION is opencode's own selection, to the letter: the newest
// assistant message with `tokens.output > 0`. A step still in flight has
// emitted no output yet — `output` is 0 — and opencode walks past it while it
// streams, so this does too; the moment the step's first output token is
// recorded, both figures move together. `undefined` where no message of the
// array qualifies.
//
// One deliberate exclusion from opencode's rule: the walk STOPS at a compaction
// message (`info.summary === true`) and answers `undefined`. Dropping the stop
// would make the figure wrong after a compaction: a compaction replaces the
// session's history with that one summary, the messages before it no longer
// describe the session's context, and the compaction turn's own figure is the
// worst reading of all — its `input` is the whole history it was given to
// summarize, i.e. the fill the compaction just removed. Reported, a freshly
// compacted session would look exactly as full as it was before, and every
// reader of this figure — the primary threshold, the subagent bands, the
// reuse gates — would act on the fill that is gone (the plugin's own compaction
// driver measures the result against this same figure). Answering "no figure
// yet" is the truth here: the next real turn produces the first one that
// describes the compacted session. This is the one situation where the number
// here can still differ from opencode's display: until that next turn,
// opencode's surfaces keep showing the compaction turn's pre-compaction figure
// while this answers undefined.
export function latestContextTokens(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info
    if (info?.summary === true) return undefined
    if (info?.role !== "assistant") continue
    const t = info.tokens
    if (!t) continue
    if (!(t.output > 0)) continue
    return (
      (t.input ?? 0) +
      t.output +
      (t.reasoning ?? 0) +
      (t.cache?.read ?? 0) +
      (t.cache?.write ?? 0)
    )
  }
  return undefined
}
