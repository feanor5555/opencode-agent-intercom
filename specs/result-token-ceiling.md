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

- The cap is on characters: `const DEFAULT_RESULT_CHARS = 8000`
  (`src/client.js:236`), env `OPENCODE_AGENT_INTERCOM_RESULT_CHARS` resolved at
  module load (`src/client.js:237-242`, `0` disables), applied by
  `function capResult(text, sessionID)` (`src/client.js:244-254`) which slices
  code points and appends
  `` `\n\n[truncated — ${omitted} more characters omitted to fit the orchestrator's context. Open subagent session ${sessionID} in the TUI for the full output.]` ``
  (`src/client.js:249-252`).
- It is applied **inside the fetch**: `result: capResult(finalResult(messages), sessionID)`
  (`src/client.js:296`), in `export async function fetchSnapshot(client, sessionID)`
  (`src/client.js:279`). Every caller of `fetchSnapshot` therefore gets the
  capped text, including callers that do not push it into any model's context.
- `export function finalResult(messages)` (`src/client.js:368`) returns the
  newest assistant message's usable text, walking back where the newest has
  none.
- The capped text is embedded by `export function completionNotice(`
  (`src/notices.js:99`) and `export function errorNotice(entry, message, wasAborted = false, result)`
  (`src/notices.js:262`). That module is `Pure composition — these functions
  only turn registry-entry / snapshot data into the wake-notice text […] No
  client, no I/O` (`src/notices.js:1-3`).
- The only token estimator in the tree is
  `export function estimateTokens(text)` → `Math.ceil(String(text).length / 4)`
  (`src/format.js:16-19`), documented as `An ESTIMATE, not a tokenizer — no
  tokenizer runs in-process` (`src/format.js:11-12`). No tokenizer is in
  `dependencies` (`package.json`: `@opencode-ai/plugin`, `jsonc-parser`).
- The subagent is told the character figure:
  `"Final reply: brief plain text (hard-capped at 8000 chars). Reference files by path:line; do not paste file contents back.\n"`
  (`src/prompts.js:77`), inside `export const SUBAGENT_GUIDE_CORE`
  (`src/prompts.js:73`), assembled by `export function guideBlocks({`
  (`src/prompts.js:269`), which already receives `agent`
  (`src/prompts.js:271`).
- That line is **not** one of the pinned contract elements: `CONTRACT_ELEMENTS`
  (`src/prompts.js:155`) covers the `Blocked:` report, the `DONE: T<n>` marker,
  the orchestrator's spawn protocol and the delegation block —
  `test/fixtures/prompt-contract.json` pins those four lines and no other.
  `export const PROMPT_CONTRACT = 1` (`src/prompts.js:137`).
- The orchestrator cannot read a file: `const PRIMARY_TOOLS = new Set([ "spawn", "abort", "list",`
  (`src/hooks.js:120-123`) and every other tool from a primary session is
  thrown back (`src/hooks.js:1777-1789`).
- A subagent at or over its budget has every tool denied:
  `if (maxContext > 0 && entry.ctxTokens != null && entry.ctxTokens >= maxContext)`
  inside `guardToolExecute` (`src/hooks.js:1670`, `src/hooks.js:1739`). So the
  subagent that most needs to file its bulk output is the one that can no
  longer write a file.
- The idle path holds everything a per-type decision needs, and holds it before
  the session is deleted: `const snapshot = await fetchSnapshot(client, sessionID)`
  (`src/hooks.js:1345`), `agent`, `handle`, `taskId`, `directory` read off the
  entry (`src/hooks.js:1319-1326`), the child hand-back
  `settleChildWaiter(sessionID, {` (`src/hooks.js:1377`) and the notice
  `completionNotice(` (`src/hooks.js:1395`).
- The error path re-reads the session for the same purpose:
  `const { result: lastText } = await fetchSnapshot(client, sessionID)`
  (`src/hooks.js:1554`), then `errorNotice(entry, errText, wasAborted, lastText)`.
- One caller uses `result` **without** pushing it into a context:
  `fetchResult: async () => (await fetchSnapshot(client, primarySessionID))?.result`
  (`src/handoffwiring.js:314`) — the primary's open-points / doc-summaries
  reply, which is parsed into todo entries, not injected.
- The per-type settings pattern to follow: `export function contextBudgetFor(agent)`
  (`src/settings.js:477`, five levels, table `DEFAULT_AGENT_CONTEXT`
  `src/settings.js:87`) and the shorter
  `export function reuseCeilingFor(agent)` (`src/settings.js:515-518`) over
  `export const DEFAULT_MAX_REUSE_CONTEXT = 70000` (`src/settings.js:138`),
  `maxReuseContext: envNum("OPENCODE_AGENT_INTERCOM_MAX_REUSE_CONTEXT", …)`
  (`src/settings.js:319`) and the validated map `reuseContext`
  (`src/settings.js:378-383`).
- The TUI side of that pattern: `function stepPerAgentCeiling(`
  (`tui/src/settings-file.ts:410`), `export function stepAgentContext(`
  (`:445`), `export function stepReuseContext(` (`:465`), rendered as the
  `max Token(k)` and `reuse Token(k)` rows behind one agent cycler
  (`tui/src/tui.tsx:1770-1830`), `const CONTEXT_STEP = 5000;`
  (`tui/src/tui.tsx:106`), `formatContextCeiling` printing `off` at `0`
  (`tui/src/tui.tsx:282-284`).
- Private, mode-0700 directory already in use for plugin state:
  `export function cacheDir()` → `~/.cache/opencode-agent-intercom`
  (`src/log.js:12-14`), `export function ensureCacheDir()` with `mode: 0o700`
  (`src/log.js:18-27`), deliberately not `/tmp` (`src/log.js:9-11`).
- A once-per-process cleanup already runs at load:
  `void sweepOrphanedSubagentSessions(client, { directory })`
  (`src/index.js:93`).

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
work-package gate's bars sit at fifths of a budget (`src/tools.js:126-129`) and
the limits block's headroom figures are pinned in the prompt tests; moving that
number moves refusals and prompt text for a question this ceiling does not ask.
The two are never applied to the same text.

**Error direction, stated:** `estimateReplyTokens` runs high. A reply the
estimator calls 2000 tokens is, for a GPT/Qwen-class BPE, 1750–2000 real
tokens for English prose and 1900–2100 for source code. It is never materially
low, which is the property the ceiling needs.

The character cap is **replaced, not kept**. `DEFAULT_RESULT_CHARS`,
`resultCharCap`, `capResult` (`src/client.js:236-254`) and the env var
`OPENCODE_AGENT_INTERCOM_RESULT_CHARS` are removed; `fetchSnapshot` returns the
full `finalResult` text. Two caps in two units with two disable switches on one
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
| `completionNotice` on the idle path (`src/hooks.js:1395`) | yes | the finished subagent's `entry.agent` |
| `settleChildWaiter` hand-back to a waiting parent (`src/hooks.js:1377`) | yes, the same capped text | the **child's** type |
| `errorNotice` on the LLM-error path (`src/hooks.js:1554`) | yes | the failed subagent's `entry.agent` |
| open-points / doc-summaries reply (`src/handoffwiring.js:314`) | **no** | — |
| `contextLimitNotice`, primary-context measurement (`src/hooks.js:729`, `:301`) | not applicable — they read `ctxTokens` only | — |

The open-points reply is parsed into todo entries and never enters a context as
text; cutting it there loses open points, which is the loss the endless cycle
exists to prevent.

Capping runs in `src/hooks.js`, before the notice builders are called, so
`src/notices.js` stays pure composition as it is documented to be.

### 2.3 The split: what the subagent is asked, what the plugin guarantees

The user's rule — *everything beyond the ceiling the subagent puts into a
file* — cannot be carried by the subagent alone: the truncation is decided
plugin-side, after the reply exists, and a subagent at its budget has every
tool denied (`src/hooks.js:1739`) precisely when its reply is longest. So the
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

- `src/prompts.js:77` becomes
  `"Final reply: brief plain text. Reference files by path:line; do not paste file contents back.\n"`
  — the figure moves to the block below, which knows the type's own value.
- A new block, appended by `guideBlocks` on the subagent branch
  (`src/prompts.js:276-283`) and rendered from `resultCeilingFor(agent)`.
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
moves, exactly as the limits block does (`src/hooks.js:227-230`).

`PROMPT_CONTRACT` is **not** bumped: the contract covers the four elements the
plugin relies on a subagent to *carry back* (`src/prompts.js:155`,
`test/fixtures/prompt-contract.json`), and the reply cap is enforced by the
plugin whatever a frozen prompt file says.

### 2.4 The overflow file

- **Directory:** `~/.cache/opencode-agent-intercom/results/`, created 0700
  through a sibling of `ensureCacheDir` (`src/log.js:18`). Not the project:
  the file is machine state, not a deliverable, and a plugin that drops
  untracked files into a user's repository on every long reply pollutes their
  `git status`. The subagent's own voluntary file goes under the project; this
  backstop does not.
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
  `spawn`/`abort`/`list` and nothing else (`src/hooks.js:120-123`,
  `:1777`). The notice says so explicitly.
- **Lifetime:** the files are the only copy once the session is deleted, so
  nothing removes them on the wake path. They are pruned once per process at
  load, beside the bootstrap sweep (`src/index.js:93`): every file in the
  results directory whose mtime is older than
  `RESULT_FILE_TTL_MS = 7 * 24 * 3600 * 1000` is deleted. Fixed constant, no
  setting — it bounds a cache directory, it does not express an intent.
- **Retention:** the file is written whether or not the session is held. A held
  session is reaped at its TTL; the file outlives it.

### 2.5 The notice wording

The marker replaces the cut tail inside the result block of the notice. Three
forms, chosen by what actually happened.

**Filed, session gone** (the default path):

```

[cut at 2000 tokens — 3412 more tokens of this reply are not shown here.
The reply IN FULL, including everything cut, is the file
~/.cache/opencode-agent-intercom/results/researcher-1-ses_7c1f.md
You cannot read that file yourself. If the rest is needed, spawn a subagent and put the path in its prompt — it reads the file. This file is the only copy; the subagent's session is gone.]
```

**Filed, session held** (retention granted for this subagent):

```

[cut at 2000 tokens — 3412 more tokens of this reply are not shown here.
The reply IN FULL, including everything cut, is the file
~/.cache/opencode-agent-intercom/results/researcher-1-ses_7c1f.md
You cannot read that file yourself. If the rest is needed, spawn a subagent and put the path in its prompt — it reads the file. The session is also still held, so reuse("researcher#1", "…") can ask it about the cut part directly.]
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
| TUI row | yes — `result Token`, third row under the agent cycler |

Resolution order in `resultCeilingFor(agent)`:

1. the type's own `resultTokens` entry from the file,
2. the flat `maxResultTokens` — file, else env
   `OPENCODE_AGENT_INTERCOM_MAX_RESULT_TOKENS`,
3. `DEFAULT_MAX_RESULT_TOKENS`.

Validation of the map mirrors `reuseContext` (`src/settings.js:378-383`): a key
is kept only when `Number.isInteger(v) && v >= 0`, anything else is dropped
silently. Resolved per call, never cached on a registry entry, for the reason
`contextBudgetFor` states.

**`0` means no ceiling** — the whole reply is forwarded, no file is written, no
marker is appended, and the reply-cap prompt block is omitted. This is the
`0` the character cap already had (`src/client.js:245`). It differs from
`reuseContext`'s `0` (never reused) and matches `agentContext`'s `0`
(gate disabled); the TUI row prints `off`, as the budget row does.

TUI (`tui/src/`):

- `tui/src/settings-file.ts`: `DEFAULT_MAX_RESULT_TOKENS = 2000`,
  `maxResultTokens: number` and `resultTokens: AgentContext` on `Settings`,
  `effectiveResultTokens(settings, agent)` (two levels, the shape
  `effectiveReuseContext` has), and `stepResultTokens(agent, delta, agents)`
  through the shared `stepPerAgentCeiling("resultTokens", "maxResultTokens", …)`
  (`tui/src/settings-file.ts:410`). First edit materialises `resultTokens` and
  drops the flat key, as the other two do.
- `tui/src/tui.tsx`: a third row under `reuse Token(k)`, label `result Token`,
  driven by the same agent cycler, `★` for a type carrying its own value,
  `off` at `0`. Its own step `const RESULT_TOKEN_STEP = 500;` and the raw token
  count as its cell — the other two rows show thousands, and a 2000-token
  ceiling stepped in 5000s is not editable.

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

- **A subagent's `read` tool accepts an absolute path outside the project
  root.** The project already works this way — `pw screenshot /tmp/page.png`
  followed by `read /tmp/page.png` stands in `README.md` as the documented
  loop. Falsified by a spawn whose prompt names a results path and that comes
  back with a read denial; the remedy is to move the directory to
  `<project>/.opencode/agent-intercom/results/` and add a `.gitignore` line,
  which changes §2.4 alone.
- **3.5 ASCII chars per token, 1 token per non-ASCII code point is not low for
  the models in use.** Falsified by one measurement: run a real tokenizer for
  the model in use over a handful of captured subagent replies and compare with
  `estimateReplyTokens`; a real count above the estimate on prose means the
  divisor drops.
- **A held session's reply reaches the orchestrator through the same idle
  path** (`src/hooks.js:1345-1400`), so `reuse` runs need no capping site of
  their own. Falsified by a `reuse` answer arriving uncut in the notice.

---

## 4. Implementation order

Each step leaves the tree building (`npm run check`) and green (`npm test`) and
can be handed out on its own.

1. **Estimator and truncation, pure.** `estimateReplyTokens` and
   `cutToTokens(text, ceiling)` in `src/format.js`, returning
   `{ kept, omittedTokens }`, walking code points against the estimator's own
   cost so the kept prefix is provably at or under the ceiling. New unit tests.
   No behaviour change. *Depends on nothing.*
2. **Settings.** `DEFAULT_MAX_RESULT_TOKENS`, the env var, `maxResultTokens`,
   the validated `resultTokens` map, `resultCeilingFor`. Nothing reads it yet.
   *Depends on nothing.*
3. **`src/resultfile.js`.** `writeOverflow({handle, agent, sessionID, taskId, runs, text, estimate, ceiling})`
   → `{ path }` or `{ error }`; `capReplyForAgent(text, meta)` → `{ text, path, error, cut }`
   composing steps 1–2 and the §2.5 marker; `pruneResultFiles()`. New unit
   tests over a temp `HOME`. *Depends on 1, 2.*
4. **Wiring.** `src/hooks.js` idle path and error path call
   `capReplyForAgent` before `settleChildWaiter` / `completionNotice` /
   `errorNotice`; `capResult` and its env var are removed from
   `src/client.js`, `fetchSnapshot` returns the full text. This is the
   behaviour switch. *Depends on 3.*
5. **Prompt.** The `src/prompts.js:77` edit and the reply-cap block in
   `guideBlocks`. *Depends on 2.*
6. **Pruning at load.** `pruneResultFiles()` beside the bootstrap sweep in
   `src/index.js:90-95`, on the same next-event-loop-turn discipline.
   *Depends on 3.*
7. **TUI.** `tui/src/settings-file.ts` keys, default, `effectiveResultTokens`,
   `stepResultTokens`; the `result Token` row in `tui/src/tui.tsx`; `npm run build`
   in `tui/`. *Depends on 2.*
8. **Documentation.** `README.md` — the env-var table row replacing
   `OPENCODE_AGENT_INTERCOM_RESULT_CHARS`, the `8 KB cap on subagent replies`
   claim, the sidebar row list, the settings-file key list; `CLAUDE.md` version
   line. *Depends on 4, 5, 7.*

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
  check that the `src/prompts.js:77` edit did not move a contract element.

### New

`test/result-token-ceiling.test.js`:

1. `estimateReplyTokens` is at or above a reference count for ASCII prose, for
   source code and for a CJK sample; it is never below the CJK reference.
2. `cutToTokens` produces a prefix whose own estimate is ≤ the ceiling, for a
   ceiling of 1, for an exactly-at-ceiling text (not cut, no marker), and for
   text one code point over.
3. A reply over the ceiling: the notice carries the marker with the path, the
   file exists with mode `0600` under `~/.cache/opencode-agent-intercom/results/`,
   and its body is byte-identical to the full reply.
4. A reply under the ceiling: no file is written and the notice carries the
   text verbatim.
5. A per-type entry raising the ceiling: the same reply passes uncut for the
   type that carries the entry and is cut for one that does not.
6. `resultTokens: { "<type>": 0 }`: no cut, no file, no marker, and the
   reply-cap prompt block absent from that type's system prompt.
7. Write failure (results directory replaced by a read-only file): the notice
   carries the not-filed marker naming the reason, and the wake still reaches
   the orchestrator.
8. Retention granted: the marker's held variant names `reuse`, and the file is
   written all the same.
9. The open-points path is not capped — a long primary reply reaches
   `requestDocSummaries` whole.
10. `pruneResultFiles` deletes a file older than `RESULT_FILE_TTL_MS` and keeps
    a fresh one.
