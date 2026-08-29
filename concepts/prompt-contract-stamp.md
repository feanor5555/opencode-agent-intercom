# Prompt contract stamp: making a reworded contract element impossible to miss

Scope: the server half of `opencode-agent-intercom` (`src/`, `test/`, `bin/`,
`README.md`). No service boundary is touched — everything here runs in the same
opencode plugin process.

## 1. What is on disk today

### The stamp

`src/prompts.js:116`

    export const PROMPT_CONTRACT = 1

Its own comment states the manual rule, `src/prompts.js:106-110`:

    // The prompt contract: the elements a system prompt has to carry for the
    // mechanics around it to work — the `Blocked:` report a subagent hands up, the
    // `DONE: T<n>` marker the wake hook removes a task on, the orchestrator's spawn
    // protocol, and the delegation block a spawning role needs. The integer is
    // bumped BY HAND whenever one of those elements changes.

### Where the stamp is written

`src/promptsfile.js:245`, inside the header comment `renderDefaultsFile` builds:

    ` ${CONTRACT_STAMP_KEY}: ${PROMPT_CONTRACT}\n` +

and the same number is repeated in the header's prose, `src/promptsfile.js:256`:

    ` then holds contract ${PROMPT_CONTRACT} whatever the plugin does next, and\n` +

### Where the stamp is read

`src/overrides.js:247-248`

    export const CONTRACT_STAMP_KEY = "agent-intercom-contract"
    const CONTRACT_STAMP = /agent-intercom-contract:\s*(\d+)/

`src/overrides.js:307-311` parses it as an integer, and `src/overrides.js:321-333`
decides on it alone:

    export function classifyPromptFile(agent, { header = "", body = "" } = {}) {
      const stamp = readContractStamp(header)
      if (stamp !== null) {
        return stamp < PROMPT_CONTRACT

with the report line built at `src/overrides.js:326-330`:

    `the prompt file was rendered against prompt contract ${stamp}, ` +
    `the current contract is ${PROMPT_CONTRACT}`

### The four covered elements, as they stand in the text

They are not named anywhere in the source. They exist twice: as prose in the
comment quoted above, and as four regexes over a *file body* in
`src/overrides.js:274-300`. The text they refer to is spread over four guide
constants:

| element | text |
|---|---|
| `blocked-contract` | `src/prompts.js:39` (orchestrator side: "A reply whose FIRST line starts with `` `Blocked:` `` is a decision handed up to you…"), `src/prompts.js:59` (subagent side: "Blocked: on a problem your prompt does not cover…"), `src/prompts.js:67` (no-spawn block), `src/prompts.js:89-92` (delegation block) |
| `done-marker` | `src/prompts.js:30` ("For task-tracked spawns, tell the subagent to put `` `DONE: T<n>` ``…"), `src/prompts.js:58` |
| `spawn-protocol` | `src/prompts.js:20-22`, the three tool lines `spawn(agent, prompt)`, `abort(handle)`, `list()` |
| `delegation-block` | `src/prompts.js:76-92`, the whole `SUBAGENT_DELEGATION_GUIDE` |

### The scan and finding path

`src/hooks.js:312` — `if (primaryScope) scanPromptFiles(primaryScope)`, once per
directory per process (`claimPromptFileScan`, `src/overrides.js:353-357`).
`scanPromptFiles` (`src/promptsfile.js:181-201`) splits each file into header and
body and calls `classifyPromptFile`; a finding goes into the register and out
through the debug log, a one-shot toast, and `overrideBlock`
(`src/overrides.js:186-208`), which is appended to the orchestrator's **stable**
system-prompt element.

### What the existing tests do and do not catch

`test/prompt-file-staleness.test.js:138-157` is the parity test. It asserts each
probe regex still matches the guide the auto path assembles:

    probe.re.test(text),
    `probe ${probe.id} no longer matches what ${agent} is injected — ${probe.why}`,

That catches a probe going stale (an element *removed* or renamed past its
anchor). It cannot catch a reword: `/`Blocked:`/` keeps matching however the rest
of that paragraph is rewritten, `/DONE: T/` likewise, `/spawn\(/` likewise.

Two tests do arithmetic on the stamp — `test/prompt-file-staleness.test.js:226`
and `:337` both use `PROMPT_CONTRACT - 1`. Any change that makes the stamp
non-numeric breaks both.

`test/prompt-guide-placeholder.test.js:113-116` asserts every rendered file
carries `` `${CONTRACT_STAMP_KEY}: ${PROMPT_CONTRACT}` ``; `:140` asserts the
stamp **never reaches the model** ("the contract stamp is author-facing only").
`test/primary-agent-identification.test.js:53` writes a fixture file with an
interpolated stamp.

### The gap, exactly

A maintainer rewords `src/prompts.js:59` (say, replacing the `Blocked:`
paragraph with different wording that means the same or something new). The
suite stays green. `PROMPT_CONTRACT` stays `1`. Every customised file in the
wild that inlined the old paragraph keeps its stamp `1`, `stamp < PROMPT_CONTRACT`
is false, and `classifyPromptFile` returns `{ missing: [], detail: "" }` — the
file is silently declared current while its frozen text is the old contract.
Recorded as pending work at `todos.md:13` and as a limitation at
`README.md:646-653`.

## 2. Open questions (left open by design, designed around)

- **Is a cosmetic reword of a covered element a contract change?** This is a
  product decision, not a code one. The recommendation below keeps that decision
  with the maintainer and forces it to be made explicitly at the moment of the
  edit; option B2 and option A take it away and answer "yes, always". Whichever
  answer is later preferred, the machinery in the recommendation supports both —
  switching to "yes, always" is then a change to one test assertion.
- **Should the wake sentence (`src/prompts.js:37`, "After spawn your turn ends —
  you are woken…") be a fifth contract element?** It is not covered today, by
  probe or prose. The design makes adding it a single table entry; the decision
  is left to whoever owns the contract.

## 3. Assumptions

1. **The guide constants are static at module load — no runtime input.** Read at
   `src/prompts.js:32-35`: the only interpolations are `percent(PACKAGE_WARN_SHARE)`
   and `percent(PACKAGE_REFUSE_SHARE)`, and `src/settings.js:383-384` defines both
   as plain module constants (`export const PACKAGE_WARN_SHARE = 0.2`). For this to
   stay true, no guide constant may interpolate a settings *getter*. It would be
   shown wrong by a guide block whose text differs between two installs of the
   same version — which would also make any digest-derived stamp per-install
   garbage.
2. **The stamp never reaches the LLM, so nothing here can move the cached prompt
   prefix.** The header comment is stripped by `stripFrontmatterComment`
   (`src/promptsfile.js:142-144`) before substitution; asserted at
   `test/prompt-guide-placeholder.test.js:140`. Shown wrong if a rendered prompt
   ever contains `agent-intercom-contract` — that assertion is the tripwire.
3. **No consumer outside this repo parses the stamp value.** `grep` over the tree
   finds `agent-intercom-contract` only in `src/overrides.js`, the two tests, and
   the docs/work notes; the TUI half does not read it. Would be shown wrong by an
   external tool reading `.opencode/agent-intercom/*.md` headers — none is known.
4. **Files in the wild carry stamp `1` or no stamp at all.** `PROMPT_CONTRACT`
   has only ever been `1` (`src/prompts.js:116`), so there is no population of
   files stamped `2` or higher. Shown wrong by a user file carrying a higher
   stamp; harmless under the recommendation, which changes no stamp semantics.

## 4. The options

### Option A — derive the stamp from a digest over the four elements

The stamp becomes `sha256(normalised element text).slice(0, 8)`, computed at
module load from the guide constants.

- **What "normalised" would have to mean.** The digest is taken over the
  *rendered* text, i.e. each guide constant split on `"\n"`, not over the source
  literal — otherwise re-wrapping a JS string concatenation without changing a
  character of the prompt changes the stamp. Element order = the table order;
  line order = render order. No trimming, no case folding: the model sees these
  bytes, and any difference in them is a difference in what the contract says.
- **On disk**: ` agent-intercom-contract: 7f3a1c9e`. `CONTRACT_STAMP`
  (`src/overrides.js:248`) widens from `(\d+)` to `([0-9a-f]{8}|\d+)`,
  `readContractStamp` stops returning a number, and `classifyPromptFile`
  (`src/overrides.js:324`) changes from `<` to `!==` — a digest carries no order,
  so "predates" can no longer be said.
- **In the report**: "the prompt file was rendered against prompt contract
  7f3a1c9e, the current contract is 2b91e0aa" — true, byte-stable, and useless to
  the reader, who cannot tell which is older or what changed.
- **Files in the wild**: every stamped file (all of them stamped `1`) is flagged
  the moment this ships, unless a compatibility table maps `1 → <digest of the
  contract-1 text>`. So the option does not avoid a migration, it needs one.
- **Cached system prompt**: unaffected within a session (assumption 2 and the
  once-per-directory scan). The block *appears* for users after every cosmetic
  release, which changes the stable element's bytes at the start of the next
  session — a fresh prefix per release, plus a report the user cannot act on
  except by re-rendering nine files.
- **Forecloses**: the maintainer's ability to fix a typo without telling every
  user their file is out of date. Also forecloses the ordered stamp and, with it,
  the "predates" wording in the report and the two `PROMPT_CONTRACT - 1` tests.
- **Demands of the builder**: the element-extraction table (which option B needs
  too), the digest, the regex widening, the comparison change, the legacy mapping,
  rewriting `test/prompt-file-staleness.test.js:226` and `:337`, and new report
  wording.

### Option B1 — keep the integer, pin the exact element text (recommended)

`PROMPT_CONTRACT` stays a hand-edited integer. A checked-in fixture holds the
exact text of the four elements as of that integer, and a test compares the
fixture with the text extracted from the live constants. A reword fails the
suite; the maintainer then either bumps the integer and re-pins (contract
change), or re-pins alone (cosmetic), and the diff shows which they chose.

- **Files in the wild**: nothing changes on adoption. No stamp is reinterpreted,
  no file is flagged. Later behaviour is exactly today's: a bump flags stamped
  files below it; unstamped files stay under the probes.
- **Cached system prompt**: no change at all — no guide byte moves, no report
  wording moves.
- **Forecloses**: nothing. A later switch to "any element change bumps
  automatically" (B2) is one assertion in the test.
- **Residual hole**: a maintainer can knowingly re-pin without bumping. That is a
  deliberate act visible in the diff, not the silent omission being fixed.
- **Demands of the builder**: the element table, a fixture, a regeneration
  script, two or three new tests.

### Option B2 — the integer, pinned append-only per contract number

As B1, but the fixture is keyed by contract number and the test asserts the pin
for the *current* number matches; the number's entry may never be edited. Any
text change is then only greenable by adding a new number.

- Same effect on the wild population as A (every cosmetic edit flags every
  stamped file), with a readable ordered stamp and no migration.
- **Forecloses** the cosmetic escape hatch, deliberately.
- Cheapest upgrade path from B1: change one assertion and freeze the fixture's
  existing entries.

### Option C — make the elements first-class in the text and rebuild the guides from them

Extract the element sentences into named constants and compose
`ORCHESTRATION_GUIDE`, `SUBAGENT_GUIDE_CORE`, `SUBAGENT_NO_SPAWN_GUIDE` and
`SUBAGENT_DELEGATION_GUIDE` from them, so element membership is structural and
no extraction table is needed.

- **Cost**: a rewrite of `src/prompts.js:17-92`, the highest-risk text in the
  repo — its bytes *are* the cached system prompt for every session. A single
  slipped space is a silent prefix-cache miss for every user.
- **Demands**: a byte-identity snapshot test over all five guide constants before
  and after, kept forever.
- **Buys**: one definition instead of two (table + text), and a fifth element
  becomes structural rather than a table entry.
- Not worth its risk at four elements; becomes worth it if the contract grows or
  if an element ever has to be injected on its own.

## 5. Recommendation

**Option B1.** Reasoning, in the order it decides:

1. The defect in `todos.md:13` is *silence*: nothing tells the maintainer that a
   decision is due. B1 removes exactly that — the suite goes red at the moment
   the element text changes, in the same commit, naming the element. It does not
   also remove the maintainer's judgement, which was never the complaint.
2. The report is user-facing and its remedy costs the user a re-render of nine
   files. A mechanism that fires on typo fixes (A, B2) trains users to ignore the
   one report that matters. The signal is worth more than the automation.
3. B1 touches no byte of the guide text and no stamp semantics, so it carries no
   migration and no risk to the cached prefix — assumptions 2 and 4 hold
   trivially. A and C both pay a real cost here.
4. B1's machinery (`CONTRACT_ELEMENTS` + `contractElementText`) is precisely what
   A and B2 also need. Choosing B1 first is therefore not a fork away from them:
   it is their first step, and either can be reached later by changing one
   assertion, with the population's behaviour already understood.

## 6. Target state

### 6.1 `CONTRACT_ELEMENTS` in `src/prompts.js`

The contract elements become nameable in the module that owns their text. Added
after `PROMPT_CONTRACT` (`src/prompts.js:116`), touching no guide constant:

- a frozen table, one entry per element, in probe order:
  `{ id, sources: [{ block: <guide constant>, name: "<constant name>", select: RegExp | null }] }`
  where `select` picks the lines of that block carrying the element and `null`
  means the whole block is the element;
- `contractElementText(id)` returning an ordered array of
  `{ block: "<constant name>", line: "<exact rendered line>" }` — each source
  block split on `"\n"`, filtered by `select` (or taken whole), concatenated in
  table order.

The four entries, verified against the current constants:

| id | sources | selects today |
|---|---|---|
| `blocked-contract` | all four guides, `select: /\`Blocked:\`/` | `ORCHESTRATION_GUIDE[24]`, `SUBAGENT_GUIDE_CORE[8]`, `SUBAGENT_NO_SPAWN_GUIDE[4]`, `SUBAGENT_DELEGATION_GUIDE[7]` (0-based, rendered lines) |
| `done-marker` | `ORCHESTRATION_GUIDE`, `SUBAGENT_GUIDE_CORE`, `select: /DONE: T/` | `ORCHESTRATION_GUIDE[15]`, `SUBAGENT_GUIDE_CORE[7]` |
| `spawn-protocol` | `ORCHESTRATION_GUIDE`, `select: /^- [a-z]+\(/` | the three tool lines `[5]`, `[6]`, `[7]` |
| `delegation-block` | `SUBAGENT_DELEGATION_GUIDE`, `select: null` | the whole block |

Two properties this shape buys, both worth keeping:

- The pin is over **rendered** text, so re-wrapping a JS string literal across
  source lines without changing a character of the prompt does not trip it. This
  matters: `SUBAGENT_DELEGATION_GUIDE` is written as seven concatenated source
  literals forming four rendered lines.
- The extraction is line-granular, so a reword of the "Right-sized chunks"
  paragraph (`src/prompts.js:32-35`) — not a covered element — does not trip it.

`contractElementText` sits on no runtime path; it exists so the definition of the
contract lives next to the text it is made of, rather than in a test file.

### 6.2 The pin: `test/fixtures/prompt-contract.json`

    {
      "contract": 1,
      "elements": {
        "blocked-contract": [ { "block": "ORCHESTRATION_GUIDE", "line": "A reply whose FIRST line …" }, … ],
        "done-marker": [ … ],
        "spawn-protocol": [ … ],
        "delegation-block": [ … ]
      }
    }

Lines are stored verbatim — no trimming, no whitespace collapsing, no
reordering. `contract` records which contract number this text belongs to, so a
re-pin without a bump is a diff in which element text changed under an unchanged
number: visible to a reviewer, which is the whole point of leaving the judgement
with a human.

### 6.3 The regenerator: `scripts/pin-prompt-contract.js`

Writes the fixture from `contractElementText` and the current `PROMPT_CONTRACT`.
Wired as `"pin:contract": "node scripts/pin-prompt-contract.js"` in
`package.json` `scripts`. Deliberately **not** under `bin/`: `bin` is in the
published `files` array (`package.json:18-24`) and this is a maintainer tool, not
a CLI the package ships.

### 6.4 The failing message

When the pin test fails it prints, per changed element: the id, the block name,
the pinned line and the current line, and then the decision to be made —

    Contract element "<id>" was reworded.
    - a change to what the contract requires → bump PROMPT_CONTRACT in
      src/prompts.js, then `npm run pin:contract`
    - a cosmetic edit that requires nothing new of a prompt file →
      `npm run pin:contract` alone

That message is the mechanism. Everything else only makes sure it is reached.

## 7. Effect on an existing customised prompt file

- **A file stamped `1` with the guide text inlined** (the case
  `test/prompt-file-staleness.test.js:310-344` covers): unchanged today. It is
  reported the first time `PROMPT_CONTRACT` becomes `2` — which now cannot happen
  without a maintainer having seen the reword.
- **A file stamped `1` carrying `{{guide}}`**: unchanged; it is not stale in
  substance either, since the guide is substituted at call time
  (`src/promptsfile.js:32-38`). A bump reports it anyway — pre-existing behaviour
  of the stamp rule, not introduced here, and the remedy (re-render) is cheap.
- **An unstamped file**: untouched. The probes (`src/overrides.js:274-300`) go on
  ruling it, and the parity test goes on guarding them.

## 8. Effect on the block in the orchestrator's cached system prompt

None. No guide byte changes, so the prompt the model sees is identical.
`overrideBlock` (`src/overrides.js:186-208`) keeps rendering the same wording
from the same integers, and its byte-stability within a session still rests on
the once-per-directory scan claim (`src/overrides.js:353-357`), untouched here.
This is the concrete advantage over option A, whose report line would carry two
digests and would appear after every cosmetic release.

## 9. Migration for stamps already written

None required. `PROMPT_CONTRACT` stays `1`, the stamp keeps its meaning and its
format, and the fixture is generated from today's text — so the pin is green by
construction on the commit that introduces it, and contract `1` is thereby
*defined* as the element text as it stands today. That definition is the
migration: it is what every file stamped `1` in the wild is henceforth measured
against.

(For contrast, option A's migration would be a `LEGACY_STAMPS = { 1: "<digest of
today's text>" }` table in `src/overrides.js`, kept forever, plus rewriting the
two `PROMPT_CONTRACT - 1` tests.)

## 10. Steps

Each step leaves the tree building and `npm test` green.

**Step 1 — the element table.** `src/prompts.js`: add `CONTRACT_ELEMENTS` and
`contractElementText` after line 116; update the comment at `src/prompts.js:106-115`
so it names the table as the definition of the four elements instead of listing
them in prose. No guide constant is edited. Depends on nothing.

**Step 2 — the id-set parity test.** `test/prompt-file-staleness.test.js`: assert
that the `CONTRACT_ELEMENTS` ids are exactly the `PROMPT_FILE_PROBES` ids
(`src/overrides.js:274-300`), and that `contractElementText(id)` returns at least
one line for every id. The second half guards the new `select` regexes the same
way the existing parity test at `:138-157` guards the probe regexes: an element
whose matcher stops selecting anything must fail loudly, not pin an empty array.
Depends on step 1.

**Step 3 — the regenerator and the fixture.** Add `scripts/pin-prompt-contract.js`
and the `pin:contract` script entry in `package.json`; run it to write
`test/fixtures/prompt-contract.json`. Depends on step 1. (Step 2 and step 3 are
independent of each other and may be handed out in either order.)

**Step 4 — the pin test.** `test/prompt-file-staleness.test.js`: the two
assertions of §11 plus the failure message of §6.4. Depends on steps 1 and 3.

**Step 5 — the documentation.** Replace the limitation bullet at
`README.md:646-653` with the current state (the contract text is pinned; a reword
fails the suite until the maintainer bumps or re-pins), and extend the prompt-file
paragraph at `README.md:330-342` with one sentence on what the stamp now
guarantees. Delete the line at `todos.md:13`. Depends on step 4.

## 11. Tests

**Add** to `test/prompt-file-staleness.test.js`:

1. *"the pinned contract text is the text the guides carry today"* — for each id
   in the fixture, `deepEqual(contractElementText(id), fixture.elements[id])`,
   with the per-element failure message of §6.4.
2. *"the pin names the contract it belongs to"* —
   `equal(fixture.contract, PROMPT_CONTRACT)`. This catches a bump that forgot the
   re-pin, the mirror image of the case above.
3. *"every contract element has a probe, and every probe an element"* — the id-set
   parity of step 2, plus the non-empty-selection assertion.

**Change**: nothing. In particular `test/prompt-file-staleness.test.js:226` and
`:337` keep their `PROMPT_CONTRACT - 1` arithmetic, and
`test/prompt-guide-placeholder.test.js:113-116` and `:140` keep holding — which is
the measure of how little this option disturbs.

**Do not add** a test asserting that a reword bumps the integer. That assertion is
option B2 and would take the judgement away; it is the one line to change if that
is later wanted.

## 12. What stays uncovered afterwards

- A reword of guide text **outside** the four elements — the wake sentence
  (`src/prompts.js:37`), the right-sized-chunks paragraph
  (`src/prompts.js:32-35`), the outline discipline (`src/prompts.js:98-104`).
  Deliberate: they are not the contract. §2 leaves the wake sentence open as a
  candidate fifth element.
- A maintainer who re-pins a genuine contract change without bumping. Visible in
  the diff by design (§6.2); removable only by adopting B2.
- A file the user repairs mid-session: still reported until the next process
  (`src/overrides.js:344-352`, `todos.md:12`). Untouched by this concept.
