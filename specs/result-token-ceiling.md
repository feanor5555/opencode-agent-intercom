# Result token ceiling

A subagent's final reply reaches the orchestrator through a **token** ceiling,
not a character one. Everything past the ceiling is cut out of the notice and
kept in a file; the notice carries that file's path. The ceiling is a value
**per agent type**, so a type that must hand its whole output up can carry a
higher one.

Boundary: the `opencode-agent-intercom` plugin — `src/` (server half, plain JS)
and `tui/src/` (TUI half, TS, separate npm package, no import across the two).

---

## 1. What the code does today

Each claim with the line it was read from.

- The cap is on tokens and is applied outside the fetch, by
  `export function capReplyForAgent(text, meta = {})` (`src/resultfile.js:240`), which
  resolves `resultCeilingFor(meta.agent)` and cuts with
  `export function cutToTokens(text, ceiling)` (`src/format.js:72`) against
  `export function estimateReplyTokens(text)` (`src/format.js:51`).
- `fetchSnapshot` returns the uncapped text: `result: finalResult(messages)`
  (`src/client.js:814`), in `export async function fetchSnapshot(client, sessionID)`
  (`src/client.js:793`).
- `export function finalResult(messages)` (`src/client.js:898`) returns the
  newest assistant message's usable text, walking back where the newest has
  none and skipping a compaction message (`info.summary === true`).
- The capped text is embedded by `export function completionNotice(`
  (`src/notices.js:238`) and `export function errorNotice(`
  (`src/notices.js:535`). That module is `Pure composition — these functions
  only turn registry-entry / snapshot data into the text an agent sees. No
  client, no I/O` (`src/notices.js:1-3`).
- Two token estimators stand in `src/format.js`:
  `export function estimateTokens(text)` → `Math.ceil(String(text).length / 4)`
  (`src/format.js:16-19`), documented as `An ESTIMATE, not a tokenizer — no
  tokenizer runs in-process` (`src/format.js:11-12`), and the conservative
  `estimateReplyTokens` (`src/format.js:51`) the reply ceiling is measured by. No
  tokenizer is in `dependencies` (`package.json`: `@opencode-ai/plugin`,
  `jsonc-parser`, `playwright-core`).
- The subagent is told no figure in its core guide:
  `"Final reply: brief plain text. Reference files by path:line; do not paste file contents back.\n"`
  (`src/prompts.js:104`), inside `export const SUBAGENT_GUIDE_CORE`
  (`src/prompts.js:100`), assembled by `export function guideBlocks({`
  (`src/prompts.js:504`), which receives `agent` (`src/prompts.js:506`) and
  appends `replyCapBlock(agent)` (`src/prompts.js:525`, defined at `:363`).
- That line is **not** one of the pinned contract elements: `CONTRACT_ELEMENTS`
  (`src/prompts.js:237`) covers the `Blocked:` report, the `DONE: T<n>` marker,
  the orchestrator's spawn protocol and the delegation block —
  `test/fixtures/prompt-contract.json` pins those four elements and no other.
  `export const PROMPT_CONTRACT = 2` (`src/prompts.js:219`).
- The orchestrator cannot read a file: `const PRIMARY_TOOLS = new Set([` holds
  `spawn`, `abort`, `list`, `message` and `reuse` (`src/hooks.js:173-192`), and every
  other tool from a primary session is thrown back (`src/hooks.js:2981-2992`).
- A subagent at or over its budget has every work tool denied — only `message`
  and `ask` pass:
  `if (maxContext > 0 && entry.ctxTokens != null && entry.ctxTokens >= maxContext)`
  inside `guardToolExecute` (`src/hooks.js:2736`, `src/hooks.js:2839`). So the
  subagent that most needs to file its bulk output is the one that can no
  longer write a file.
- The idle path holds everything a per-type decision needs, and holds it before
  the session is deleted: `const snapshot = await fetchSnapshot(client, sessionID)`
  (`src/hooks.js:2112`), `agent`, `handle`, `taskId`, `directory` read off the
  entry (`src/hooks.js:2066-2074`), the cap `capReplyForAgent(snapshot.result, {`
  (`src/hooks.js:2149`), the child hand-back `settleChildWaiter(sessionID, {`
  (`src/hooks.js:2169`) and the notice `completionNotice(` (`src/hooks.js:2199`).
- The error path re-reads the session for the same purpose:
  `const snapshot = await fetchSnapshot(client, sessionID)` (`src/hooks.js:2559`),
  secures it through `secureSubagentState(snapshot, {` (`src/hooks.js:2574`,
  defined at `src/resultfile.js:324`), then
  `errorNotice(entry, errText, wasAborted, recovered.text, …)` (`src/hooks.js:2594`).
- One caller uses `result` **without** pushing it into a context:
  `fetchResult: async () => (await fetchSnapshot(client, primarySessionID))?.result`
  (`src/handoffwiring.js:383`) — the primary's open-points / doc-summaries
  reply, which is parsed into todo entries, not injected.
- The per-type settings pattern to follow: `export function contextBudgetFor(agent)`
  (`src/settings.js:801`, five levels, table `DEFAULT_AGENT_CONTEXT`
  `src/settings.js:123`) and the shorter
  `export function reuseCeilingFor(agent)` (`src/settings.js:839-843`) over
  `export const DEFAULT_MAX_REUSE_CONTEXT = 70000` (`src/settings.js:248`),
  `maxReuseContext: envNum("OPENCODE_AGENT_INTERCOM_MAX_REUSE_CONTEXT", …)`
  (`src/settings.js:555`) and the validated map `reuseContext`
  (`src/settings.js:648-654`).
- The TUI side of that pattern: `function stepPerAgentCeiling(`
  (`tui/src/settings-file.ts:699`), `export function stepAgentContext(`
  (`:734`), `export function stepReuseContext(` (`:754`), rendered as the
  `max Token(k)` and `reuse Token(k)` rows in the LLM params section,
  behind one agent cycler that walks the full role list (`AGENT_NAMES`,
  orchestrator included), directly after the `effort` row and before
  `[reset current agent]` (`tui/src/tui.tsx:2705-2777`),
  `const CONTEXT_STEP = 5000;` (`tui/src/tui.tsx:156`), `formatContextCeiling`
  printing `off` at `0` (`tui/src/tui.tsx:353-355`).
- Private, mode-0700 directory already in use for plugin state:
  `export function cacheDir()` → `~/.cache/opencode-agent-intercom`
  (`src/log.js:12-14`), `export function ensureCacheDir()` with `mode: 0o700`
  (`src/log.js:18-26`), deliberately not `/tmp` (`src/log.js:9-11`).
- A once-per-process cleanup runs at load:
  `void sweepOrphanedSubagentSessions(client, { directory })`
  (`src/index.js:157`).

---

## 2. Target state

### 2.1 Counting tokens

No tokenizer is added. The plugin serves arbitrary local models
(Qwen/Llama/Mistral families), whose vocabularies differ from any one BPE table
a dependency would ship, so an exact count for *the* model is not obtainable in
process anyway, and a ~2 MB encoding table on a plugin with two runtime
dependencies is not paid for by a precision that is still approximate.

The reply ceiling is measured by a **second, deliberately conservative
estimator** in `src/format.js`, beside the existing one:

```js
// Conservative token estimate for text that is about to be pushed into another
// agent's context. ASCII at 3.5 chars per token, one token per non-ASCII code
// point. Overestimates plain English by ~14 %, sits within ~10 % of source
// code, JSON and paths, and no longer underestimates CJK and emoji by a factor
// of three the way chars/4 does. Overestimating is the safe direction here: it
// cuts earlier, and everything cut is kept in the overflow file.
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
```

`estimateTokens` (chars / 4) stays exactly as it is and keeps its callers: the
work-package gate's bars sit at fifths of a budget (`src/tools.js:146-148`) and
the limits block's headroom figures are pinned in the prompt tests; moving that
number moves refusals and prompt text for a question this ceiling does not ask.
The two are never applied to the same text.

**Error direction, stated:** `estimateReplyTokens` runs high. A reply the
estimator calls 2000 tokens is, for a GPT/Qwen-class BPE, 1750–2000 real
tokens for English prose and 1900–2100 for source code. It is never materially
low, which is the property the ceiling needs.

There is no character cap: `fetchSnapshot` returns the full `finalResult` text
(`src/client.js:814`). Two caps in two units with two disable switches on one
piece of text is a configuration surface nobody can reason about, and the
conservative estimator makes a character backstop redundant: truncation walks
code points against the estimator's own cost function, so the produced prefix
is bounded in both units by construction.

### 2.2 Where the ceiling is applied

Capping moves **out of the fetch** and to the points where a subagent's text
crosses into another agent's context. `fetchSnapshot` becomes what its name
says and gains no I/O.

| Crossing point | Capped | Ceiling resolved for |
|---|---|---|
| `completionNotice` on the idle path (`src/hooks.js:2199`) | yes | the finished subagent's `entry.agent` |
| `settleChildWaiter` hand-back to a waiting parent (`src/hooks.js:2169`) | yes, the same capped text | the **child's** type |
| `errorNotice` on the LLM-error path (`src/hooks.js:2594`) | yes | the failed subagent's `entry.agent` |
| open-points / doc-summaries reply (`src/handoffwiring.js:383`) | **no** | — |
| `contextLimitNotice`, primary-context measurement (`src/hooks.js:1110`, `:469-470`) | not applicable — they read `ctxTokens` only | — |

The open-points reply is parsed into todo entries and never enters a context as
text; cutting it there loses open points, which is the loss the endless cycle
exists to prevent.

Capping runs in `src/hooks.js`, before the notice builders are called, so
`src/notices.js` stays pure composition as it is documented to be.

### 2.3 The split: what the subagent is asked, what the plugin guarantees

The user's rule — *everything beyond the ceiling the subagent puts into a
file* — cannot be carried by the subagent alone: the truncation is decided
plugin-side, after the reply exists, and a subagent at its budget has every
work tool denied (`src/hooks.js:2839`) precisely when its reply is longest. So the
rule is split, and the guarantee sits on the plugin's side.

**Asked of the subagent** (prompt, best effort): put long material in a file
*while it is working*, under the project, and keep the reply to findings plus
the path. This is the good outcome: the file is where the work belongs, named
by the subagent, in the project, and the reply is short enough that nothing is
cut.

**Guaranteed by the plugin** (backstop, unconditional): when the reply still
exceeds the ceiling, the plugin writes the reply **in full** to an overflow
file before the session is deleted, and the notice carries the path. No text is
ever lost, whatever the subagent did or could not do.

Prompt changes in `src/prompts.js`:

- `src/prompts.js:104` reads
  `"Final reply: brief plain text. Reference files by path:line; do not paste file contents back.\n"`
  — the figure stands in the block below, which knows the type's own value.
- A new block, appended by `guideBlocks` on the subagent branch
  (`src/prompts.js:514-526`) and rendered from `resultCeilingFor(agent)`.
  Omitted entirely when that ceiling is `0`:

```
---
📄 agent-intercom: your final reply is capped.
The orchestrator sees at most ~2000 tokens (~7000 characters) of your final reply. Everything past that is cut out of what it receives and written to a file, and it gets that file's path instead of your words — it cannot see them.
So file the long material yourself, while you still have your tools: write it under the project, and let your reply carry the findings and the path. A reply that leaves the cut to decide what survives keeps its opening and loses its conclusion.
---
```

The figure in the block is the resolved ceiling for that agent type. The block
sits in the stable system-prompt element and moves only when the settings file
moves, exactly as the limits block does (`src/hooks.js:394-398`).

`PROMPT_CONTRACT` is **not** bumped: the contract covers the four elements the
plugin relies on a subagent to *carry back* (`src/prompts.js:237`,
`test/fixtures/prompt-contract.json`), and the reply cap is enforced by the
plugin whatever a frozen prompt file says.

### 2.4 The overflow file

- **Directory:** `<entry.directory>/work/agent-intercom-result-<handle>-<sessionID>[-runN].md`,
  where `entry.directory` is the subagent's own project directory and MUST be
  absolute (`src/resultfile.js` `overflowTarget`). The private cache dir
  `~/.cache/opencode-agent-intercom/results/` is the fallback for the only
  case that has no project — a subagent whose entry carries a missing or
  relative directory. The overflow file goes under the project because that
  is where the orchestrator's next subagent can actually read it: a subagent
  is given the file's path in the wake notice and walks it; a path under
  `~/.cache/...` lives outside every project and lands in the cache-fallback
  marker (see §2.5). `work/` is the project's own scratch area for a run's
  reports; nothing prunes what is written there — it is the project's file,
  not cache state.
- **Name:** `<safeHandle>-<sessionID>.md`, where `safeHandle` is the handle with
  every character outside `[A-Za-z0-9._-]` replaced by `-` (`researcher#1` →
  `researcher-1`). A follow-up run of a retained session adds `-run<N>` for
  `N > 1`, so a `reuse` never overwrites the earlier run's file.
- **Mode:** file `0600`, written with `fs.writeFileSync(path, text, { mode: 0o600 })`.
- **Written by:** the plugin, in `src/resultfile.js` (new module), called from
  the two `src/hooks.js` paths. Best-effort in the log.js sense — it never
  throws into the wake path; a failure is reported inside the notice (§2.5).
- **Content:**

```
# subagent result — researcher#1 (researcher)
session: ses_7c1f…
finished: 2026-08-30T12:34:56.789Z
task: T5
size: ~5412 tokens (estimated), cut to 2000 in the orchestrator's notice

---

<the final reply, verbatim and complete, including the part that was cut>
```

  The `task:` line is omitted where the spawn carried no `T<n>:` prefix.
- **Read by:** a subagent, never the orchestrator — a primary session may run
  `spawn`/`abort`/`list`/`message`/`reuse` and nothing else (`src/hooks.js:173-192`,
  `:2981`). The notice says so explicitly.
- **Lifetime:** the files are the only copy once the session is deleted, so
  nothing removes them on the wake path. `pruneResultFiles` runs once per
  process at load over the cache fallback only (`src/resultfile.js:348`,
  `src/index.js:168-173`); files written under a project's `work/` are NOT pruned,
  because `work/` belongs to the project and the project decides what stays.
  The cache directory itself is bounded by
  `RESULT_FILE_TTL_MS = 7 * 24 * 3600 * 1000`. Fixed constant, no setting —
  it bounds a cache directory, it does not express an intent.
- **Retention:** the file is written whether or not the session is held. A held
  session is reaped at its TTL; the file outlives it.

### 2.5 The notice wording

The marker replaces the cut tail inside the result block of the notice. Three
forms, chosen by what actually happened.

**Filed, session gone** (the default path):

```

[cut at 2000 tokens — 3412 more tokens of this reply are not shown here.
The reply IN FULL, including everything cut, is the file
<entry.directory>/work/agent-intercom-result-researcher-1-ses_7c1f.md
That file is in the project under `work/`. You have no read tool yourself, so spawn a subagent and put the path in its prompt — it reads the file. This file is the only copy; the subagent's session is gone.]
```

Where the entry carried no absolute directory and the file fell back to the
private cache dir, the same block reads:

```

[cut at 2000 tokens — 3412 more tokens of this reply are not shown here.
The reply IN FULL, including everything cut, is the file
~/.cache/opencode-agent-intercom/results/researcher-1-ses_7c1f.md
That path is outside the project, in this plugin's private cache. You cannot read it yourself; a subagent given the path can. This file is the only copy; the subagent's session is gone.]
```

**Filed, session held** (retention granted for this subagent):

```

[cut at 2000 tokens — 3412 more tokens of this reply are not shown here.
The reply IN FULL, including everything cut, is the file
<entry.directory>/work/agent-intercom-result-researcher-1-ses_7c1f.md
That file is in the project under `work/`. You have no read tool yourself, so spawn a subagent and put the path in its prompt — it reads the file. The session is also still held, so reuse("researcher#1", "…") can ask it about the cut part directly.]
```

**Not filed** (the write failed):

```

[cut at 2000 tokens — 3412 more tokens of this reply are not shown here, and the overflow file could not be written (EACCES: permission denied). The cut text exists only in subagent session ses_7c1f — open that session in the TUI to read it, or have the work redone with a brief that asks for less.]
```

Figures: the ceiling as configured, and the omitted count as
`estimateReplyTokens(full) − estimateReplyTokens(kept)`, printed as plain
integers (the notice's other token figures use `fmtTokens`, which rounds to
`5.4k`; an omitted-count that reads `3.4k` where the ceiling reads `2000` is
two units on one line). The word is **cut**, not *truncated*, so a reader of
the notice cannot confuse it with `outline`'s
`[truncated — N more declarations]` (`test/plugin.test.js:2071`).

The marker itself is plugin framing and is not counted against the ceiling,
like the notice's head, tail, run-size and slots lines.

### 2.6 Configuration surface

Following `reuseCeilingFor` exactly — three levels, no built-in per-type table,
no legacy key.

| | |
|---|---|
| Constant | `export const DEFAULT_MAX_RESULT_TOKENS = 2000` (`src/settings.js`, beside `DEFAULT_MAX_REUSE_CONTEXT`) |
| Env var | `OPENCODE_AGENT_INTERCOM_MAX_RESULT_TOKENS` |
| Flat file key | `"maxResultTokens": N` |
| Per-type file key | `"resultTokens": { "<agent>": N }` |
| Resolver | `export function resultCeilingFor(agent)` in `src/settings.js` |
| TUI row | yes — `result Token`, third row in the LLM params section under the shared agent cycler |

Resolution order in `resultCeilingFor(agent)`:

1. the type's own `resultTokens` entry from the file,
2. the flat `maxResultTokens` — file, else env
   `OPENCODE_AGENT_INTERCOM_MAX_RESULT_TOKENS`,
3. `DEFAULT_MAX_RESULT_TOKENS`.

Validation of the map mirrors `reuseContext` (`src/settings.js:648-654`): a key
is kept only when `Number.isInteger(v) && v >= 0`, anything else is dropped
silently. Resolved per call, never cached on a registry entry, for the reason
`contextBudgetFor` states.

**`0` means no ceiling** — the whole reply is forwarded, no file is written, no
marker is appended, and the reply-cap prompt block is omitted. It differs from
`reuseContext`'s `0` (never reused) and matches `agentContext`'s `0`
(gate disabled); the TUI row prints `off`, as the budget row does.

TUI (`tui/src/`):

- `tui/src/settings-file.ts`: `DEFAULT_MAX_RESULT_TOKENS = 2000`,
  `maxResultTokens: number` and `resultTokens: AgentContext` on `Settings`,
  `effectiveResultTokens(settings, agent)` (two levels, the shape
  `effectiveReuseContext` has), and `stepResultTokens(agent, delta, agents)`
  through the shared `stepPerAgentCeiling("resultTokens", "maxResultTokens", …)`
  (`tui/src/settings-file.ts:699`). First edit materialises `resultTokens` and
  drops the flat key, as the other two do.
- `tui/src/tui.tsx`: a third row in the LLM params section under
  `reuse Token(k)`, label `result Token`, driven by the same agent cycler
  (the full role list, orchestrator included), `★` for a type carrying its
  own value, `off` at `0`. Its own step `const RESULT_TOKEN_STEP = 100;`
  (`tui/src/tui.tsx:160`) and the raw token count as its cell — the other two
  rows show thousands and step by `CONTEXT_STEP = 5000` (`tui/src/tui.tsx:156`),
  which cannot edit a ceiling in the low thousands. The row sits
  directly after the `effort` row and before `[reset current agent]`; the
  Subagents section has no agent cycler any more, and `[reset current
  agent]` does not touch this row.

### 2.7 A higher ceiling for a future agent type

Through the per-type map and nothing else. A type that must hand its whole
output up carries its own `resultTokens` entry:

```json
{ "resultTokens": { "<the-type>": 20000 } }
```

or `0` for a type that is never cut at all. Three consequences follow from
§2.2–§2.6 without any further mechanism: the ceiling is resolved from the
producing agent's type at each crossing point, the reply-cap prompt block that
type sees names *its* figure (or is omitted at `0`), and the TUI row edits it
under the agent cycler like any other type. No code names such a type, and
none is added here.

---

## 3. Assumptions

- **A subagent's `read` tool accepts an absolute path under the project.**
  This is the assumption that made the project-local location the default in
  §2.4 — the orchestrator's next subagent can read the file the plugin writes.
  Falsified by a spawn whose prompt names a results path under `<entry.directory>/work/`
  and that comes back with a read denial; the remedy is to fall back to the
  cache directory for that one project and have the orchestrator pass the
  absolute cache path on a future spawn. The §2.5 marker already names the
  cache case as a distinct phrasing, so the change is the resolver alone.
- **3.5 ASCII chars per token, 1 token per non-ASCII code point is not low for
  the models in use.** Falsified by one measurement: run a real tokenizer for
  the model in use over a handful of captured subagent replies and compare with
  `estimateReplyTokens`; a real count above the estimate on prose means the
  divisor drops.
- **A held session's reply reaches the orchestrator through the same idle
  path** (`src/hooks.js:1949-2251`), so `reuse` runs need no capping site of
  their own. Falsified by a `reuse` answer arriving uncut in the notice.

---

## 4. Where it lives

- **Estimator and truncation** — `estimateReplyTokens` and
  `cutToTokens(text, ceiling)` in `src/format.js`; `cutToTokens` returns
  `{ kept, omittedTokens }` and walks code points against the estimator's own
  cost, so the kept prefix is at or under the ceiling.
- **Settings** — `DEFAULT_MAX_RESULT_TOKENS`, the env var
  `OPENCODE_AGENT_INTERCOM_MAX_RESULT_TOKENS`, the flat `maxResultTokens`, the
  validated per-type `resultTokens` map and `resultCeilingFor` in
  `src/settings.js`.
- **Overflow file** — `src/resultfile.js`: `writeOverflow` returns `{ path }`
  or `{ error }`; `capReplyForAgent(text, meta)` returns
  `{ text, path, error, cut }`, composing the two items above and the §2.5
  marker; `secureSubagentState` is the error path's variant; and
  `pruneResultFiles()` reaps the cache fallback.
- **Wiring** — the idle path in `src/hooks.js` caps through
  `capReplyForAgent(snapshot.result, {` (`src/hooks.js:2149`) before
  `settleChildWaiter` (`:2169`) and `completionNotice` (`:2199`); the error
  path secures through `secureSubagentState(snapshot, {` (`src/hooks.js:2574`,
  which calls `capReplyForAgent` with `secure: true`,
  `src/resultfile.js:324-332`) before `errorNotice` (`:2594`).
  `fetchSnapshot` applies no cap and returns the full text
  (`result: finalResult(messages)`, `src/client.js:814`).
- **Prompt** — the final-reply line of `SUBAGENT_GUIDE_CORE`
  (`src/prompts.js:104`) and the per-type `replyCapBlock` in `guideBlocks`.
- **Pruning at load** — `pruneResultFiles()` runs once per process beside the
  bootstrap sweep (`src/index.js:162-173`), on the next event-loop turn.
- **TUI** — `effectiveResultTokens` and `stepResultTokens` in
  `tui/src/settings-file.ts`, and the `result Token` row in `tui/src/tui.tsx`.
- **Documentation** — the `OPENCODE_AGENT_INTERCOM_MAX_RESULT_TOKENS` row of
  the README's env-var table, the `result Token` sidebar row and the
  settings-file key list.

---

## 5. Tests

### Existing, touched

- `test/plugin.test.js:1266` — *an oversized subagent result is truncated
  before it lands in the wake notice*: rewritten against the token marker
  (`/\[cut at \d+ tokens — \d+ more tokens/`), and extended to assert the file
  path in the notice and the full text on disk.
- `test/settings.test.js` — resolution of `maxResultTokens` / `resultTokens`
  and the map's validation, beside the existing `reuseContext` cases.
- `test/settings-defaults-parity.test.js` — `DEFAULT_MAX_RESULT_TOKENS`, the
  env-var name and the whole `resultCeilingFor` ↔ `effectiveResultTokens`
  chain pinned across the two halves.
- `test/result-recovery.test.js` — the error path now carries a capped
  `lastText` and, above the ceiling, a file path.
- `test/system-prompt-stability.test.js` — the reply-cap block belongs to the
  stable element and must not move between turns of one session.
- `test/nested-delegation.test.js`, `test/nesting-fixes.test.js` — a nested
  `researcher` reply reaching its parent is capped against the researcher's
  ceiling.
- `test/tui-settings-write.test.js` — `stepResultTokens` materialises
  `resultTokens`, drops the flat key, and drops a type's entry when stepped
  below zero.
- `test/prompt-contract-pin.test.js` — must stay green untouched; it is the
  check that the `src/prompts.js:104` line did not move a contract element.

### New

`test/result-token-ceiling.test.js`:

1. `estimateReplyTokens` is at or above a reference count for ASCII prose, for
   source code and for a CJK sample; it is never below the CJK reference.
2. `cutToTokens` produces a prefix whose own estimate is ≤ the ceiling, for a
   ceiling of 1, for an exactly-at-ceiling text (not cut, no marker), and for
   text one code point over.
3. A reply over the ceiling: the notice carries the marker with the path, the
   file exists with mode `0600` under `<entry.directory>/work/` (an absolute
   project directory), and its body is byte-identical to the full reply.
   `pruneResultFiles` does NOT touch it.
4. A reply under the ceiling: no file is written and the notice carries the
   text verbatim.
5. A per-type entry raising the ceiling: the same reply passes uncut for the
   type that carries the entry and is cut for one that does not.
6. `resultTokens: { "<type>": 0 }`: no cut, no file, no marker, and the
   reply-cap prompt block absent from that type's system prompt.
7. Write failure (the project `work/` cannot be created, e.g. a read-only file
   in the way): the notice carries the unfiled marker naming the reason, and
   the session is HELD rather than deleted — the `hold` option on
   `teardownSubagent` keeps the opencode session standing because it is the
   only remaining copy of the cut text.
8. Retention granted: the marker's held variant names `reuse`, and the file is
   written all the same.
9. The open-points path is not capped — a long primary reply reaches
   `requestDocSummaries` whole.
10. `pruneResultFiles` deletes a file older than `RESULT_FILE_TTL_MS` and keeps
    a fresh one, and only over the cache directory: files written under a
    project's `work/` are left alone.
11. An entry with a relative `directory` (whatever `opencode serve` was
    started in) lands the overflow file in the cache dir, and the §2.5
    marker names the cache location with the "outside the project" phrasing.
12. A subagent whose session is HELD because the overflow file could not be
    written is not addressable by `reuse` — the entry has been removed and
    only the opencode session remains. The orphan sweep
    (`sweepOrphanedSubagentSessions`, `src/teardown.js`) secures its state
    first through `secureSubagentState` (`src/resultfile.js`) and deletes
    only a session whose state reached a file, or one past
    `ORPHAN_SWEEP_HOLD_GRACE_MS` (a grace on top of the sweep's own minimum
    age), which is then logged with its `unfiled:` reason. The result file's
    directory comes from the session record, with the sweep's `directory`
    argument and the cache dir as fallbacks; handle and agent read
    `ORPHAN_RESULT_HANDLE = "orphan"` / `ORPHAN_RESULT_AGENT = "unknown"`.
