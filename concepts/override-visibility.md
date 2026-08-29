# Concept: making a silent override visible

Status: implemented, 2026-08-29.

Scope: the `opencode-agent-intercom` plugin (`/home/user/opencode-agent-intercom`),
opencode 1.18.25. Two defects of one shape, answered together:

- **A** — a project file `.opencode/agent/<name>.md` displaces a plugin role
  wholesale (prompt, permission map, model, description), with nothing reporting
  it. Second casualty: `detectAgentFromSystem` loses the `# Role:` header it
  identifies the primary by.
- **B** — a customised prompt file under `.opencode/agent-intercom/<agent>.md`
  that predates a change to the prompt contract keeps the old contract in force,
  with nothing reporting it.

Evidence base: `work/diagnosis-orchestrator-override.md`, this plugin's `src/`,
and the opencode 1.18.25 source at `/tmp/opencode-source` (git tag `v1.18.25`,
`packages/opencode/package.json:2` `"version": "1.18.25"`).

---

## 1. What the material actually shows

### 1.1 The displacement is the plugin's own merge rule, not an unreachable source

The briefing states that `.opencode/agent/<name>.md` is "a higher-precedence
agent source than the entry the plugin writes into `config.agent`". The source
says otherwise, and the correction is what makes a cheap fix possible.

opencode folds markdown agents **into `config.agent`** while it resolves the
config, before any plugin sees it:

    /tmp/opencode-source/packages/opencode/src/config/config.ts:474
      result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
    /tmp/opencode-source/packages/opencode/src/config/config.ts:475
      result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))

`ConfigAgent.load(dir)` is the markdown loader — it globs the agent directories
and decodes each file into an agent entry:

    /tmp/opencode-source/packages/opencode/src/config/agent.ts:13
      for (const item of await Glob.scan("{agent,agents}/**/*.md", { ... }))
    /tmp/opencode-source/packages/opencode/src/config/agent.ts:24
      const config = { name, ...md.data, prompt: md.content.trim() }

The plugin `config` hook runs **after** that, and receives the already-merged
object, which it mutates in place:

    /tmp/opencode-source/packages/opencode/src/plugin/index.ts:152
      const cfg = yield* config.get()
    /tmp/opencode-source/packages/opencode/src/plugin/index.ts:247
      try: () => Promise.resolve((hook as any).config?.(cfg)),

So the plugin's write is the **last** word, not the first. What discards the
plugin's fields is the plugin's own merge, which puts the project's entry on top
per top-level key:

    src/agents.js:325
      config.agent[name] = { ...base, ...config.agent[name] }
    src/agents.js:322-324 (the comment that states the intent)
      // Plugin role as base, overlaid by whatever fields the project already set
      // (user wins per top-level key). Idempotent: re-running just re-applies the
      // same merge.

That the plugin's writes are effective is directly observable in the diagnosis:
the eight roles the project defines no markdown for reach the model with the
plugin's prompts, and they exist only because the config hook wrote them —

    work/diagnosis-orchestrator-override.md:43-46
      The plugin's other 8 roles are unaffected — the project defines no md for them:
          coder    promptLen 1002, prompt starts "# Role: Coder (Subagent)"

**Consequence for the design:** detection needs no HTTP request and no new
resolution path. At `installAgents` time the collision is already in hand — the
pre-existing `config.agent[name]`. And the merge granularity is a decision the
plugin is free to take, per field.

### 1.2 An empty `permission` object is indistinguishable from none

Every markdown agent gets a `permission` object materialised whether or not the
frontmatter sets one:

    /tmp/opencode-source/packages/core/src/v1/config/agent.ts:68
      const permission: ConfigPermissionV1.Info = {}
    /tmp/opencode-source/packages/core/src/v1/config/agent.ts:77
      globalThis.Object.assign(permission, agent.permission)
    /tmp/opencode-source/packages/core/src/v1/config/agent.ts:80
      return { ...agent, options, permission, ...(steps !== undefined ? { steps } : {}) }

Under `{ ...base, ...config.agent[name] }` that always-present key replaces the
plugin's whole map. There is no signal anywhere that separates "the user asked
for an empty permission map" from "the user set no permission at all" — the
information does not survive normalisation. Only a **per-key** reading of the
map recovers an intent that is actually expressed.

The resolved agent list carries no origin field either — no path, no `source`,
no `builtIn` (`/tmp/opencode-source/packages/opencode/src/agent/agent.ts:35-55`,
the `Info` schema behind `GET /agent`). Naming the offending file therefore
means the plugin looks for it on disk itself; it cannot be read off the config.

### 1.3 The tool lock survives displacement; the prompt does not

A displaced orchestrator is told it may `read`/`edit`/`bash`, and then every
such call is refused anyway, because the primary lock does not consult the
permission map at all:

    src/hooks.js:1299
      if (!PRIMARY_TOOLS.has(input.tool)) {
    src/hooks.js:86-90
      const PRIMARY_TOOLS = new Set([ "spawn", "abort", "list", ])

So the damage of problem A on the orchestrator is not a breach of enforcement —
it is a **contradiction** handed to the model: a prompt that promises tools and a
guard that denies them, turn after turn, plus the loss of the role prompt, the
description, and the model pin. For a *subagent* role name the picture is
different: the runtime re-check reads the resolved config and nothing else,

    src/config.js:159
      const decision = config?.agent?.[callerAgent]?.permission?.[tool]
    src/config.js:145-146
      // Permission.disabled schema strip uses, so a project override that REMOVED
      // a deny is honored (no false-deny).

so a markdown file named `coder.md` does silently hand that role the web tools
and everything else the plugin denies it. That is a real hole, and 1.2 says the
hole opens even when the file's author wrote no `permission:` line at all.

### 1.4 The primary is identified by a header the displacement removes

    src/hooks.js:184
      const agentName = isSubagent ? entry.agent : detectAgentFromSystem(output) ?? "orchestrator"
    src/hooks.js:499-506
      function detectAgentFromSystem(output) {
        ...
        const m = /^#\s*Role:\s*([A-Za-z]+)/m.exec(head)

Live-observed as returning `null` under displacement
(`work/diagnosis-orchestrator-override.md:62` `detected = null`), masked by the
literal fallback. The name is not cosmetic: it selects the custom prompt file,

    src/hooks.js:309
      const customTemplate = sessionDir ? loadCustomPrompt(sessionDir, agentName) : null

so a project whose primary is called `build` loads `orchestrator.md` today.

opencode does hand the plugin the resolved agent name — just not on this hook.
The system transform gets two fields only:

    /tmp/opencode-source/packages/opencode/src/session/llm/request.ts:69-73
      yield* input.plugin.trigger(
        "experimental.chat.system.transform",
        { sessionID: input.sessionID, model: input.model },
        { system },
      )

while `chat.message`, which fires once per user turn *before* the request loop,
carries it:

    /tmp/opencode-source/packages/opencode/src/session/prompt.ts:1000-1008
      yield* plugin.trigger(
        "chat.message",
        {
          sessionID: input.sessionID,
          agent: input.agent,
          ...

`input.agent` there is a name string (`packages/opencode/src/session/prompt.ts:636`
`const agentName = input.agent` then `agents.get(agentName)`), and this plugin
already reads it, with the message's own field as fallback:

    src/llmmodel.js:101
      const agent = nonEmptyString(input?.agent) ? input.agent : message.agent

### 1.5 The prompt file freezes the contract because the contract is inlined

`renderDefaultsFile` bakes the guide text into the file as literal Markdown:

    src/promptsfile.js:186-188
      const guide = stripVisualSeparators(
        isOrch ? ORCHESTRATION_GUIDE : SUBAGENT_GUIDE_CORE,
      ).trim()
    src/promptsfile.js:213
      parts.push("\n", guide, "\n")

and the loaded file then replaces the assembled prompt entirely
(`src/hooks.js:310-322`, `output.system.push(result); return`). Every later
change to `SUBAGENT_GUIDE_CORE` or `ORCHESTRATION_GUIDE` — the `Blocked:`
contract is the current example — stops at that file. Note a second instance
already on disk in every such file: `SUBAGENT_DELEGATION_GUIDE` and
`SUBAGENT_NO_SPAWN_GUIDE` are injected by the auto path
(`src/hooks.js:334-337`) but were never rendered into the template at all, so a
delegating role driven from a prompt file is told nothing about spawning.

### 1.6 What surfaces exist for telling the user

- `showToast` — `src/client.js:393-395`, `client.tui.showToast(...)`, fails soft.
  Already used for handoff scheduling (`src/hooks.js:250`, `src/hooks.js:272`).
  Direct to the user, ephemeral, needs an attached TUI.
- The per-turn message part — `src/hooks.js:437-448`, pushed with
  `synthetic: true` onto a per-request copy that "opencode transforms and never
  writes back" (`src/hooks.js:411-413`). Model-visible, **not** user-visible, and
  it moves the trailing prefix, so it costs a cache breakpoint every turn.
- The stable system prompt element `[0]` — `src/hooks.js:348-356`. Model-visible,
  free as long as its text does not move within a session
  (`src/hooks.js:169-171`: "Nothing in either element varies from turn to turn").
- `postNotice` — `src/client.js:36-51`, posts a message and **wakes** the
  session. Wrong instrument here: it would start a turn.
- The house pattern for "the model tells the user": `src/notices.js:213-222`,
  `denialLoopNotice`, which ends "Tell the user the subagent appears stuck".

---

## 2. Target state

One register, two detectors, three outlets, one merge-policy change, one
identification fix.

### 2.1 The register — `src/overrides.js` (new)

A process-scoped list of findings plus the renderers over it. Pure apart from
the fs probe in 2.3; imports `agents.js`, `prompts.js`, `log.js` and nothing
from `hooks.js` (which imports it), so the existing layering holds.

Finding shape:

    { kind: "agent-entry" | "prompt-file",
      agent: "<role name>",
      fields: ["prompt", "permission", "model", "description"],   // agent-entry
      missing: ["blocked-contract", "done-marker"],               // prompt-file
      file: "<absolute path or null>",
      detail: "<one line>" }

API:

    recordAgentEntryOverride(finding)     // called from installAgents
    recordPromptFileOverride(finding)     // called from the prompt-file scan
    hasFindings()                         // sync
    overrideBlock()                       // stable system-prompt text, "" when clean
    overrideToastText()                   // one-shot toast body, null when clean or already shown
    resetOverrides()                      // test seam, mirroring src/state.js `resetState`

Findings are keyed `kind + directory + agent` so a repeated detection
cannot duplicate a line and findings from different projects stay independent;
`installAgents` is documented idempotent (`src/agents.js:323`) and will
re-report the same collision on every re-run.

### 2.2 Detector A — collision at the config hook

In `installAgents`, before the merge, for each name in `AGENTS`: an existing
`config.agent[name]` **is** the collision. Classify it by comparing each field
the plugin sets against what the project entry carries:

- `prompt` present and not equal to the plugin's → the role prompt is displaced.
- `permission` present → record which of the plugin's `deny` keys the project's
  map does not carry (after the merge change of 2.4, these are the keys the
  plugin re-imposes, which is exactly what the report should name).
- `model`, `description`, `mode`, `hidden`, `color` → recorded as
  "also overridden", one line, no verdict — these are the user's to own.

Cost: a handful of property reads at bootstrap, inside a hook that already runs
once per opencode instance. No I/O, no request, no new cache.

Naming the file is a separate, best-effort step: probe
`<directory>/.opencode/agent/<name>.md`, `<directory>/.opencode/agents/<name>.md`
and the same two under the opencode global config dir, take the first that
exists, and report `file: null` when none does (which is the honest answer when
the entry came from `opencode.json`). `installAgents` gains an optional second
argument for the directory; `index.js` already holds it (`src/index.js:70`
`const { client, directory, serverUrl } = ctx`). Every fs call wrapped, failure
degrades to `file: null`.

### 2.3 Detector B — stale prompt file

Two mechanisms, because one alone does not cover the files that already exist.

**Contract probes (retroactive, works on today's files).** A static table in
`overrides.js`, one probe list per role, each probe an `{ id, re, why }`. The
probes are the contract elements the auto path would inject for that role:

| id | applies to | probe | why |
|---|---|---|---|
| `blocked-contract` | all 9 | `/^\s*Blocked:/m` or `/`Blocked:`/` | the subagent hands a decision up (`src/prompts.js` SUBAGENT_GUIDE_CORE / ORCHESTRATION_GUIDE) |
| `done-marker` | the 6 TODO roles + orchestrator | `/DONE: T/` | the wake hook removes the task on this marker (`src/hooks.js` task outcome) |
| `spawn-protocol` | orchestrator | `/spawn\(/` | the three tools it has |
| `delegation-block` | the 5 delegating roles | `/spawn\("researcher"/` | `mayDelegate` roles are granted a target they are never told about |

A file missing a probe is stale for that probe. The table lives next to the
constants it mirrors, with a unit test asserting that each probe still matches
the current constant — so a future edit to `prompts.js` that drops a contract
element fails the test instead of silently making every file "fresh".

**Contract stamp (precise, forward-looking).** `renderDefaultsFile` writes
`agent-intercom-contract: <N>` into the header HTML comment; `PROMPT_CONTRACT`
is a single integer in `prompts.js`, bumped by hand whenever a contract element
changes. A file whose stamp is below the current one is stale by stamp even if
the probes happen to pass; a file with no stamp falls back to the probes. The
stamp is inside the comment `stripFrontmatterComment` removes
(`src/promptsfile.js:127-129`), so it never reaches the model.

**When it runs.** Once per project directory, at the first primary
`transformSystem` — which already awaits `getSessionDirectory` on that path
(`src/hooks.js:194-196`) — scanning all nine names in one pass and memoising per
directory. Cost: nine `stat`s and up to nine reads of ~4 KB, once per process.
Scanning eagerly rather than lazily per agent is deliberate: it makes the finding
set complete before the first block is rendered, so the block's text is stable
for the rest of the session (see 2.5). The cost of "once" is that a file the
user repairs mid-session keeps its finding until the next process, which is the
same trade the stable element demands.

### 2.4 Merge policy — what the plugin concedes and what it keeps

`installAgents` changes in exactly one respect: `permission` is merged **per
tool key** instead of being replaced wholesale.

    // plugin denies as the base, each key the project names wins over it
    permission: { ...base.permission, ...projectEntry.permission }

Everything else keeps today's rule — the project's value wins for
`prompt`, `description`, `model`, `mode`, `hidden` and `color`.

Why permission and nothing else: §1.2 shows the map arrives materialised on
every markdown agent, so wholesale replacement reads an empty object as "grant
everything" when the author said nothing at all. Per-key merging honours every
intent the author can actually express (`read: allow` in the frontmatter still
wins) and discards only an intent nobody can express. The prompt, by contrast, is
unambiguous: a file with a body means the author wrote a prompt, and that stays
the author's.

### 2.5 Delivery — three outlets, each doing what it can

1. **Debug log**, always, at detection: full finding with fields and path
   (`log()` → `~/.cache/opencode-agent-intercom/debug.log`). Costs nothing, and
   it is what a later diagnosis reads.
2. **Toast**, once per process, on the first primary transform after the
   findings are complete: `showToast(client, { title: "agent-intercom", message:
   "<N> role(s) overridden by project files — see the orchestrator's first
   answer", variant: "warning" })`. Same call site pattern as `src/hooks.js:250`.
   Fails soft with no TUI attached.
3. **A block in the primary's stable system prompt**, naming every finding and
   instructing the orchestrator to report it to the user in its next answer —
   the `denialLoopNotice` pattern (`src/notices.js:219-221`). This is the outlet
   that actually reaches a user with no TUI open and after the toast is gone.

The block is appended to `guideParts` on the auto path (after `limits`,
`src/hooks.js:343`) and appended to the substituted result on the custom-template
path (`src/hooks.js:319-321`, after `applyCustomPrompt`) — the template owns the
layout, but a warning that the template itself is stale cannot be inside it.
Primary only; a subagent cannot reach the user, and its own findings are reported
through the primary's block because the register is process-wide.

Cache cost: the block belongs in the stable element precisely because its text
does not move once the scan of 2.3 has run. Worst case is one invalidation per
session — the first turn renders "" if the scan has not completed, the second
renders the block — which the eager scan removes by completing before the first
render.

### 2.6 Refusal boundary

The plugin **reports and does not refuse**, with one already-existing exception
band and one narrow addition:

- Never refuses to load, never throws from the `config` hook, never removes or
  rewrites a project's agent entry, never refuses a `spawn` because of a finding.
- Unchanged hard enforcement, independent of any permission map: the primary tool
  lock (`src/hooks.js:1299`), the unconditional `task` deny for subagents
  (`src/hooks.js` guard), the spawn gate's `SPAWNABLE_ROLES`
  (`src/agents.js:305-310`).
- The one addition is 2.4: the plugin's `deny` entries survive a project map that
  does not name them. That is the whole of the line moved, and it is documented
  in `README.md` as a behaviour change.

The reason the line sits there: enforcement of the delegation pattern is stated
as the plugin's purpose and its opt-out is removal (`src/index.js:36-38`
"Enforcement is the plugin's core purpose — to opt out, remove the plugin"), so
silently surrendering the deny map to a file that said nothing is out of
character; but the prompt, the model and the description carry no enforcement and
belong to whoever wrote the file.

### 2.7 Primary-agent identification

Replace `detectAgentFromSystem(output) ?? "orchestrator"` with a resolution
chain, most authoritative first:

1. `entry.agent` from the registry — subagents, unchanged.
2. **`sessionAgent.get(sessionID)`** — a new `Map` in `src/state.js`, written by
   the `chat.message` hook from `input.agent ?? output.message.agent`, exactly the
   read `src/llmmodel.js:101` already performs. That hook fires once per user turn
   before the request loop (§1.4), so the name is in hand at the first transform
   of every turn, displacement or not.
3. The `# Role:` header regex — still correct whenever the plugin's own prompt is
   intact, and the only source when a session's first request arrives by a path
   that skipped `chat.message`.
4. `config.default_agent` as resolved at the `config` hook — captured in
   `agents.js` where it is already written (`src/agents.js:326`) — instead of the
   literal `"orchestrator"`.

The map is bounded by pruning on `session.deleted` / on registry removal, or
simply by being one small string per live session; the existing `lastPrimaryTool`
map (`src/state.js`) sets the precedent for the second.

Behaviour change to note: a primary named something else stops loading
`orchestrator.md`. It keeps `ORCHESTRATION_GUIDE`, which the non-subagent branch
injects without consulting the name (`src/hooks.js:341-345`).

---

## 3. Options weighed

### 3.1 Where detection A runs

| option | cost | forecloses | demands of the builder | verdict |
|---|---|---|---|---|
| **In `installAgents` at the `config` hook** | property reads at bootstrap, no I/O | nothing | passing `directory` into `installAgents` to name the file | **recommended** |
| Via `client.app.agents()` at first transform | one HTTP request per process; a new module-level cache beside `loadServerAgents` (`src/config.js:67-83`) | nothing | handling the async gap on turn 1, and a per-directory cache the existing one does not have | rejected: it reads the *resolved* list to learn a fact the config hook already holds, and buys nothing the config object lacks — the resolved list has no origin field either (§1.2) |
| Per LLM call, from the parsed role slice | free, already parsed | sees only the agent that is running, and only prompt displacement | nothing | kept as a secondary signal only: it is what §2.7 rung 3 does anyway |

The `app.agents()` route stays worth naming because it would catch a displacement
introduced by a source the config hook does not see. No such source exists in
1.18.25 (§1.1); if one appears, this is the fallback and the finding model does
not change.

### 3.2 What to do about a collision

| option | cost | forecloses | demands | verdict |
|---|---|---|---|---|
| Report only, merge unchanged | none | leaves §1.3's subagent hole open — a `coder.md` with no frontmatter silently grants web tools | none | rejected |
| **Report + per-key `permission` merge** | a project that wants a fully-capable role must name each tool in frontmatter | a user's intent to hand a role everything by writing `permission: {}` — which they cannot express anyway (§1.2) | one merge line, a README paragraph, a test per direction | **recommended** |
| Report + plugin wins on `prompt` too | none technically | the whole point of a project-defined agent | none | rejected: this is the user's file and the plugin has no standing to overwrite its body |
| Refuse: drop the project entry / throw from the `config` hook | breaks a project that deliberately overrides | every legitimate override | none | rejected: a plugin that fails a whole instance over a configuration choice is worse than the defect |

### 3.3 Where the finding is delivered

| option | cost | forecloses | demands | verdict |
|---|---|---|---|---|
| Toast only | ephemeral; invisible in headless `opencode serve` and to a user who was not looking | nothing | one call | insufficient alone |
| Per-turn message part (`transformMessages`) | a cache breakpoint **every turn** for a text that never changes; not user-visible (the array is never written back, `src/hooks.js:411-413`) | nothing | nothing | rejected as the primary channel |
| **Stable system-prompt block + toast + log** | at most one cache invalidation per process, removed by the eager scan | nothing | the block must be text that does not move within a session | **recommended** |
| `postNotice` into the session | starts a turn the user did not ask for | nothing | nothing | rejected |
| A row in the companion TUI panel | a second npm package, a new file contract between them, a coordinated release | nothing | out of this concept's boundary | deferred, see §6 |

### 3.4 How a stale prompt file is recognised

| option | cost | forecloses | demands | verdict |
|---|---|---|---|---|
| Contract stamp only | blind to every file that exists today — which is the whole reported population | nothing | a bump discipline | insufficient alone |
| Content probes only | a probe list that can drift from the constants | nothing | the parity test of §2.3 | works retroactively; keep |
| **Both, plus `{{guide}}` in the default render** | one more placeholder; a file rendered fresh no longer shows the guide text inline for editing | editing the guide *in place* — the user must paste it in to change it, which then pins it, deliberately | rendering change + legend line + migration note | **recommended**: probes and stamp *detect*, the placeholder *prevents*, and prevention is what stops the class recurring |
| Diff the file against `renderDefaultsFile` output | trivial to implement | nothing — but flags every customised file, which is every file that matters | nothing | rejected: it detects customisation, not staleness |

---

## 4. Assumptions

1. **Markdown agents are merged into `config.agent` before the plugin `config`
   hook, and the plugin's write is last.** Holds if `config.ts:474-475` runs
   inside config resolution and `plugin/index.ts:247` after it. *Falsified by:*
   the plugin's own eight roles ceasing to reach the model, or a one-line debug
   log of `Object.keys(config.agent)` at the top of the `config` hook not
   containing a role the project defines a markdown file for.
2. **`ConfigAgentV1.normalize` materialises `permission` on every markdown
   agent** (`packages/core/src/v1/config/agent.ts:68,80`). *Falsified by:* an md
   agent with no frontmatter permission arriving at the hook with
   `permission === undefined` — in which case detector A must treat "absent" and
   "empty" differently and the per-key merge becomes strictly better still.
3. **`chat.message` fires before the first system transform of a turn and
   carries a string agent name.** *Falsified by:* the session→agent map being
   empty at the first transform of a fresh session; the header regex and
   `default_agent` rungs cover that case, so the failure is a downgrade, not a
   break.
4. **One opencode instance serves one project directory for process-scoped
   caches.** This is an assumption the code already makes
   (`src/config.js:20-24`, module-scope config cache) and this concept inherits
   it; the prompt-file scan is memoised **per directory** so it does not deepen
   the assumption. *Falsified by:* two sessions with different `?directory=`
   values in one server showing each other's findings.
5. **The user wants to be told, not to be stopped.** Nothing in the material
   states it; it follows from §2.6's reading of `src/index.js:36-38` plus the
   fact that the override mechanism is a documented feature
   (`src/agents.js:10-12`). *Falsified by:* the user asking for a hard refusal on
   a role collision.

---

## 5. Steps

Each step leaves the tree building (`npm run check`) and its tests green
(`npm test`), and can be handed out on its own.

**Step 1 — robust primary identification.** `sessionAgent` map in `state.js`,
written from `chat.message` in `index.js`/`llmmodel.js`, read as rung 2 of the
chain in `hooks.js`; `default_agent` captured in `agents.js` as rung 4; the
`?? "orchestrator"` literal removed. Tests: a primary named `build` resolves to
`build`; a displaced `orchestrator` with no `# Role:` header still resolves;
`chat.message`-less path falls through to the header, then to `default_agent`.
*Depends on: nothing.* First because it is the smallest change, it removes a
mask that would otherwise hide regressions in later steps, and every later step
reads `agentName`.

**Step 2 — the register.** `src/overrides.js` with the finding model,
`recordAgentEntryOverride`, `recordPromptFileOverride`, `hasFindings`,
`overrideBlock`, `overrideToastText`, `resetOverrides`. Pure; unit tests over the
renderers only. *Depends on: nothing.* Can run in parallel with step 1.

**Step 3 — detector A + merge policy.** `installAgents(config, { directory })`:
classify the collision, record it, merge `permission` per key. Tests: a project
entry with `permission: {}` keeps every plugin deny; an entry with
`{ read: "allow" }` keeps the rest and loses `read`; a prompt-only entry keeps the
plugin permissions and reports `prompt`; the file probe finds
`.opencode/agent/<name>.md` and reports `null` when there is none; idempotence
across two `installAgents` runs yields one finding. *Depends on: step 2.*

**Step 4 — delivery.** `overrideBlock()` appended on both transform paths,
toast once per process, log at detection. Tests: the block appears in
`output.system[0]` for a primary and never for a subagent; the block appears
after the substituted template on the custom path; the block is byte-identical
across two turns of one session; no finding → no block and no toast.
*Depends on: steps 2 and 3 (a finding to render) and step 1 (a reliable
primary/subagent split).*

**Step 5 — detector B.** Contract-probe table + `PROMPT_CONTRACT` stamp read,
the eager per-directory scan at the first primary transform, findings into the
register. Tests: a file rendered by the current `renderDefaultsFile` is clean; a
fixture file with the pre-`Blocked:` guide reports `blocked-contract`; a
delegating role's file with no `spawn("researcher"` reports `delegation-block`;
the parity test asserting each probe still matches its constant; the scan runs
once per directory. *Depends on: steps 2 and 4* (the register and the outlet it
renders into).

**Step 6 — structural prevention.** `renderDefaultsFile` writes the stamp and a
`{{guide}}` placeholder in place of the inlined guide; `transformSystem`
substitutes `guide` with exactly what the auto path would inject for that role
(core + delegation-or-no-spawn + outline), so a fresh file cannot go stale.
Tests: a freshly rendered file substitutes to the same text the auto path
assembles; an old inlined file still works unchanged (`substitutePrompt` leaves
unknown keys in place, `src/promptsfile.js:134-139`). *Depends on: step 5* — the
stamp is defined there and the probes must already exist so the migration note
can point at them.

**Step 7 — documentation.** `README.md`: the per-key permission merge as a
behaviour change, what an override report means, how to silence one (fix the file
or accept it). `learnings.md`: the resolution order of §1.1 with its citations.
*Depends on: steps 3 and 6.*

---

## 6. Out of scope

- Changing opencode itself, or asking upstream for an origin field on the
  resolved agent. §1.2 records the absence; the design works without it.
- Any veto: refusing to load, refusing a spawn, deleting or rewriting a project's
  agent file or config entry.
- A row in the companion TUI panel. It is a separate npm package with its own
  release and its own file contract (`~/.config/opencode/agent-intercom.json`);
  a findings channel across that boundary is a follow-on concept, not this one.
- Semantic validation of a user's custom prompt beyond the literal probes — no
  LLM review, no judgement of whether the prompt is *good*.
- Collisions on agent names the plugin does not define. A project's own agents
  are not this plugin's roles and it has nothing to say about them.
- A new settings key for switching the reports off. The findings are cheap and
  the plugin's stated purpose is enforcement; if an off switch is wanted later it
  is one key in `settings.js` plus the TUI parity test
  (`test/settings-defaults-parity.test.js`).
- The consequences of a displaced `mode`/`hidden` for the TUI agent switcher.
