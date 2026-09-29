# Concept: what the orchestrator asked for — five wishes, three new roles, one tool, two mechanisms

Boundary: the plugin `/home/wu/opencode-agent-intercom` (server side `src/`, the shipped CLI
`bin/pw.js` with `bin/pw-lib.js` and `bin/shims/pw`, the TUI copy `tui/src/` where a role list
or a default is mirrored there, the unit and e2e tests). What belongs to the project
`/home/wu/vidl` or to the user's own config files is named as such and handed out of this
boundary in §8.

State: the concept is built. Its code stands in the working tree on top of HEAD `1ff5bb1`
("feat: cut the role set for weak models and add scout and checker roles"), uncommitted.
Every statement about the code carries the line it stands on in that working tree. Other
input: the coverage map `work/orchestrator-role-wishes-map.md`; the review
`work/architecture-reviewer-agent-role-gaps.md`; the user's `~/.config/opencode/llm-models.json`
and `agent-intercom.json`; and, for how opencode carries images, the opencode source at
`/home/wu/.claude/scratch/oc-src/anomalyco-opencode-545f51d/packages/` (package version
1.18.32; the installed binary answers `1.18.33`). opencode paths below are relative to that
`packages/` directory.

User decisions taken on 2026-09-28 and worked in here:

- `calc` is granted to the orchestrator as well (§3).
- The `verifier` has vision: it looks at what it produced — screenshots of the browser or
  wasm host, rendered output — and judges them itself (§5).

User decisions taken on 2026-09-29 and worked in here:

- `scout` and `checker` run on `cliproxy/qwen3.8-flash-medium`. Both pins stand in
  `llm-models.json` (`"scout"` at `:38-41`, `"checker"` at `:42-45`, each
  `{ "providerID": "cliproxy", "modelID": "qwen3.8-flash-medium" }`).
- One slot pool: there is no separate cap for light roles — no `maxLightSubagents`, no
  `LIGHT_ROLES` (§7.4).
- The claim check is not the scout's. The scout is the pure locator and summariser; checking
  claims against the tree is the role `refuter` (§4), the one owner of claim verification.
- The `verifier`'s `write` is granted without a limit: no path check in code, no `work/`
  rule in its prompt (§5).
- The `releaser` holds `edit`: its map carries no `edit: "deny"`, and its prompt lets it change
  a file where a step of the procedure says so (§6).

The user's aim that binds every choice below: the design gives weak models the means to solve
well-cut agentic-programming tasks. Each mechanism is a way through for the model that meets
it — a reply form to fill, a role to name, one `ask` — and a hard refusal is used only where
the alternative is a wrong result reported as a right one.

## 0. The five wishes, and what binds the answer

The primary orchestrator, asked which subagents it misses, named five, each out of a real
session in `/home/wu/vidl`:

1. **Runtime verifier** — executes the artefact (the wasm build in a browser) instead of
   reasoning from docs; bun does not load the artefact, so nobody saw what the browser does.
2. **Premise attacker** — falsifies the orchestrator's briefing claims against the tree
   BEFORE implementation (a coder found claimed facts that did not exist; a reviewer
   refuted "all paths closed" afterwards).
3. **Number oracle** — seconds-cheap arithmetic instead of carrying it in expensive coder runs.
4. **Release/publish agent** — the long pole build wasm → rsync → commit → push → re-pin →
   install.
5. **Cost/slot guard** — the global cap of 6 refused it ~20 times; a documenter ran 43 min
   with 204k nested tokens for text it already had; something that asks "does this really
   need a run?".

Explicitly unwanted: more bookkeeping agents, and an all-knowing agent with memory.

Stored decisions this design keeps:

- The spawnable set is closed and reachable only through the orchestrator. It is
  `SPAWNABLE_ROLES`, derived from `AGENTS` — `.filter(([, def]) => def.mode === "subagent")`
  (`src/agents.js:713-717`). A plugin role joins it by being an `AGENTS` entry; a project
  agent never does.
- Nested delegation is blocking and bounded by `maxNestedSpawns` (default 2,
  `export const DEFAULT_MAX_NESTED_SPAWNS = 2`, `src/settings.js:296`) and the acyclic
  target graph `NESTED_SPAWN_TARGETS` (`src/agents.js:350-357`), whose keys are planner,
  coder, debugger, reviewer, designer (each → `researcher`) and researcher (→ `grounder`).
  **No role of this concept has a nested target and no edge was added to the graph.**
- A role without a nested target carries `...NO_SPAWN` in its own map (`src/agents.js:322-324`),
  as grounder, documenter, gitter, scout, refuter, checker, verifier and releaser do (`:569`,
  `:535`, `:592`, `:607`, `:622`, `:637`, `:655`, `:672`). The map is what `mayDelegate` reads
  (`:391-393`) for the offline prompt files and the contract probes; `installAgents`
  additionally forces `spawn: "deny"` on every subagent without targets (`:997-999`), which
  reaches only the live config.
- A project `.opencode/agent/<name>.md` displaces a plugin role. Consequence for wish 4: a
  vidl-only release agent defined in the project would not be spawnable (closed set), so the
  release role is a plugin role whose project-specific part is a file the project owns.
- Model pins live in `~/.config/opencode/llm-models.json`, never in `src/agents.js`
  (`resolveModelForAgent`, `src/llmmodel.js:91`). The tier suggestions below are entries for
  that file.
- `gitter` and `documenter` decide nothing: the orchestrator hands each a fully specified task
  (`src/agents.js:57`), copied from the coder's `Commit:` and `Docs:` lines (`:58`,
  `:135-137`). The releaser follows the same rule: what it carries out is stated for it, it
  composes nothing.
- Money-costing verification runs are standing-approved for this project; the e2e drivers of
  the test plans run without asking.

### 0.1 How prompt text is written in this concept

Every prompt text below — the three role prompts, the protocol line, the orchestrator's
dispatch lines, the coder line, the checklist — follows one standard: it says what to do, not
what to avoid; its sentences are short enough for a weak model to follow; it hands the model a
next move (a reply form, a role to name, one `ask`) wherever it reaches the edge of the task;
and it is as short as its content allows, because a local model's context is small. Each text
carries its size as an estimate at four characters per token; the figure that counts is the
pinned model's tokenizer, and the prompt-contract fixture (§3) is where a change in the
protocol block becomes visible.

`ORCHESTRATOR_PROMPT` as built (`src/agents.js:46-66`, 4323 characters, ~1080 tokens):

| line in the code | where | est. tokens |
|---|---|---|
| role line naming five tools, `calc` included | `src/agents.js:48` | ~20 |
| available subagents (14) | `:49` | ~38 |
| pick line, refuter, verifier and releaser picks included | `:50` | ~300 |
| premise rule (refuter) | `:51` | ~42 |
| runtime rule (verifier) | `:52` | ~20 |
| release rule (releaser) | `:53` | ~34 |
| pre-spawn checklist | `:54` | ~77 |
| cut unit, rename site list | `:55` | ~62 |
| usual order, with refuter, verifier and release | `:56` | ~61 |
| exact-brief line for gitter and documenter | `:57` | ~120 |
| copy the `Commit:`/`Docs:` lines | `:58` | ~33 |

The texts this concept added:

| text | where | est. tokens |
|---|---|---|
| `REFUTER_PROMPT` | §4 | ~235 |
| `VERIFIER_PROMPT` | §5.4 | ~335 |
| `VERIFIER_NO_VISION_LINE` (only on a non-vision model) | §5.1 | ~27 |
| `RELEASER_PROMPT` without `${GIT_STEPS}` | §6 | ~240 |
| `GIT_STEPS` (shared with `GITTER_PROMPT`, §6) | §6 | ~100 |
| `calc` in the role line | §3 | ~2 |
| `calc` protocol line (`ORCHESTRATION_GUIDE`) | §3 | ~36 |
| three names in "Available subagents" | §4–§6 | ~6 |
| pick-line additions (refuter, verifier, releaser) | §4–§6 | ~74 |
| three dispatch rules (premise, runtime, release) | §4–§6 | ~96 |
| usual-order additions (refuter, verifier, release) | §4–§6 | ~25 |
| pre-spawn checklist | §7.2 | ~77 |
| reuse clause in `ORCHESTRATION_REUSE_GUIDE` | §7.2 | ~26 |
| coder premise line | §4 | ~34 |

The orchestrator's role prompt carries ~280 tokens of them; its protocol block ~36, and ~26
more where retention is on. Each new subagent carries its own prompt only; `SCOUT_PROMPT` and
`CHECKER_PROMPT` are unchanged.

## 1. What the code says

### 1.1 Roles and their hand-kept copies

Fifteen roles, one primary and fourteen subagents, in `AGENTS` (`src/agents.js:474-678`). A
subagent entry is `mode: "subagent", hidden: true`, a `permission` deny map and a `prompt`
constant; absence of a key is the grant ("`permission` maps tools a role must not have to
`deny`; everything else stays enabled by default", `src/agents.js:463-464`).

A subagent with no nested target cannot spawn: `installAgents` writes
`if (isSubagentRole(name) && nestedSpawnTargets(name).length === 0) { merged.permission = { ...merged.permission, spawn: "deny" } }`
(`src/agents.js:997-999`), its map carries `NO_SPAWN` (§0), and its prompt gets
`SUBAGENT_NO_SPAWN_GUIDE` instead of a delegation block
(`(delegates ? delegationGuideFor(agent) : SUBAGENT_NO_SPAWN_GUIDE)`, `src/prompts.js:594`).
The three new roles rely on exactly this.

The role set is **also listed by hand** in these places; each carries the three new roles, and
each is either derived or held by a test:

| place | what it lists | guard |
|---|---|---|
| `src/agents.js:49-50` (`ORCHESTRATOR_PROMPT`) | "Available subagents: scout, refuter, planner, coder, checker, verifier, debugger, reviewer, documenter, researcher, grounder, designer, gitter, releaser." and the pick-by-artifact line | `test/role-briefs.test.js:244-249`: the Available line names exactly `SPAWNABLE_ROLES` |
| `src/settings.js:130-145` `DEFAULT_AGENT_CONTEXT` | one budget per role | `test/settings-defaults-parity.test.js` pins keys to `SPAWNABLE_ROLES` |
| `tui/src/agent-roles.ts:19-35` `AGENT_NAMES`, `:86-101` `DEFAULT_AGENT_CONTEXT`, `:106` `VISION_ROLES` | TUI copy | same parity test |
| `src/prompts.js:373` `OUTLINE_DISABLED_AGENTS` | `new Set(["designer", "documenter", "gitter", "grounder", "checker", "verifier", "releaser"])` | membership/permission parity: a member's map denies `outline` (`test/prompt-guide-placeholder.test.js`) |
| `src/hooks.js:348-355` `AGENTS_MD_SUBAGENTS` (exported) | `"coder", "debugger", "reviewer", "checker", "verifier", "releaser"` | `test/role-briefs.test.js:253-261`, against the line below |
| `src/promptsfile.js:91-99` `HAS_AGENTS_MD` (exported) | the same set plus `orchestrator`, for the offline prompt files — a copy, because `src/hooks.js` imports this module | `test/role-briefs.test.js:253-261`: equals `AGENTS_MD_SUBAGENTS` plus `orchestrator` |
| `src/overrides.js:307-314` `DELEGATING_AGENTS` | roles that may spawn | unchanged: no new role delegates |
| `test/e2e/config-isolation.sh:108` `E2E_PINNED_AGENTS` | `"orchestrator planner coder debugger reviewer documenter researcher designer gitter scout refuter checker verifier releaser build plan general title summary compaction"`; `grounder` stands on `E2E_PIN_EXEMPT_AGENTS` (`:117`), it keeps its own model | `test/e2e-config-isolation.test.js:223-240`: pinned plugin roles == `AGENT_NAMES` minus the exempt list, the rest == opencode's turn agents |
| literal side lists `DELEGATING_ROLES`/`NON_DELEGATING_ROLES` in `test/nested-delegation.test.js:63-71`, `test/nested-spawn.test.js:60`, `test/plugin.test.js:603` | literal by intent ("Kept literal rather than derived, so a role that changes side has to be moved here deliberately", `test/nested-delegation.test.js:61-62`) | each file asserts the union equals `SPAWNABLE_ROLES` and the two are disjoint (`test/nested-delegation.test.js:181`) |
| `test/spawn-size.test.js:397-417`, `test/plugin.test.js:1775`, `:1803` | read `SPAWNABLE_ROLES` | derived |

Derived and needing no edit: `SPAWNABLE_ROLES`, `HAS_OUTLINE` (`src/promptsfile.js:83-85`),
`mayDelegate`, `roleHoldsWrite` (`src/agents.js:401-403`), the solo disable, the TODO refusal
text (`is restricted to ${[...TODO_AGENTS].join(" / ")}`, `src/hooks.js:2911`) and
`DONE_MARKER_AGENTS` (`src/overrides.js:291`, held to `TODO_AGENTS` by
`test/prompt-file-staleness.test.js`).

### 1.2 The concurrency cap and nested spawns

- Built-in `DEFAULT_MAX_SUBAGENTS = 1` (`src/settings.js:119`); live
  `"maxSubagents": 6` (`~/.config/opencode/agent-intercom.json:2`).
- The decision counts every running subagent in the process, one pool:
  `refused: maxSubagents > 0 && !nested && active >= maxSubagents` (`src/registry.js:934-942`),
  with `countActiveSubagents` starting from `let n = pendingSpawns.count`
  (`src/registry.js:883-884`) and the reserve a single counter,
  `pendingSpawns.count += 1` (`src/registry.js:1015-1017`).
- Refusal: "Subagent limit reached (${cap.active}/${maxSubagents} running globally across all
  orchestrator sessions). Wait for one to finish …" (`src/tools.js:691-697`).
- Nested spawns bypass the cap and are bounded by the per-entry quota
  (`nestedQuotaDecision`, `src/registry.js:959-969`; refusal `src/tools.js:650-671`). Child
  cost is booked, never gated: `entry.nestedTokens = (entry.nestedTokens ?? 0) + ctxTokens`
  (`chargeNestedRun`, `src/registry.js:999-1007`).

### 1.3 The run ceiling bounds with the silence window off

The live file switches both older windows off: `"maxSubagentToolCallMs": 0` and
`"maxSubagentAgeMs": 0` (`agent-intercom.json:63-64`). The sweep skips only those two:
`if (maxAge <= 0 && limit.kind !== "run") continue` (`src/watchdog.js:184`), under the comment
"The inactivity watchdog switched off takes the silence and tool-call windows with it; the run
ceiling keeps its own switch" (`:182-183`). The wrap-up band is silent only where the type's
ceiling is 0 (`if (!(ceilingMs > 0)) return ""`, `src/hooks.js:1418`).

The run ceiling is `DEFAULT_MAX_SUBAGENT_RUN_MS = 2640000` (`src/settings.js:215`), overridden
per role by `agentRunMs` (read at `src/settings.js:644-649`, resolved by `runCeilingFor`,
`:964`). The live file sets `agentRunMs` for scout, refuter, verifier, releaser and documenter
(`agent-intercom.json:52-58`, §8 U2), so a documenter run is cut at 20 min.

### 1.4 Retention, the cheapest "no new run", is on

`DEFAULT_MAX_RETAINED_SUBAGENTS = 2` (`src/settings.js:241`); live
`"maxRetainedSubagents": 2` (`agent-intercom.json:60`). The `reuse` tool is registered and the
orchestrator can put a follow-up to a finished subagent without a fresh run.

### 1.5 The primary's tool allowlist and its prompt

`PRIMARY_TOOLS` is `spawn`, `abort`, `list`, `message`, `reuse`, `calc`
(`src/hooks.js:180-204`). The role line names the five that exist in every orchestrator-mode
process: "You delegate work to subagents. Your tools: spawn, message, abort, list, calc."
(`src/agents.js:48`). `reuse` is named only in `ORCHESTRATION_REUSE_GUIDE`
(`src/prompts.js:73-81`), which is injected only where retention is on; the drift guard in
`test/role-briefs.test.js:105-117` requires every member of `PRIMARY_TOOLS` in the role line
except `reuse`, which must stand in that guide and nowhere in the static prompt. The protocol
block lists the five tools (`src/prompts.js:34-38`) and is by its own comment "Pure tool-usage
protocol — no workflow, no project conventions" (`src/prompts.js:22-23`); dispatch rules live
in `ORCHESTRATOR_PROMPT` (`src/agents.js:50-58`).

The prompt contract pins every `- tool(` line of the protocol block: the `spawn-protocol`
element selects `/^- [a-z]+\(/` from `ORCHESTRATION_GUIDE` (`src/prompts.js:306-315`), fixture
`test/fixtures/prompt-contract.json`.

### 1.6 What the other roles do beside the new ones

- Coder "Run build and tests yourself after the change — report only verified work as done."
  (`src/agents.js:132`) and, for a change in behaviour, "add or extend a test that fails
  without your change and passes with it" (`:130`) — in vidl, `bun test` runs a stub of the
  wasm module, not the module (`/home/wu/vidl/notes/wasm-test-oracle.md`: "Thus unit tests
  execute the stub, not the real wasm"). "Verified" there proves nothing about the browser.
- Checker "run[s] the checks your briefing names — tests, lint, type-check, build — and
  report[s] what they print" (`src/agents.js:241`), each "as the briefing names it" (`:242`),
  on a cheap tier. It reports exit codes and counts; it does not open the artefact in its
  target runtime, so the vidl stub case passes it too.
- Scout "answer[s] one question about this code: where something is, who calls it, what a
  file or function does" (`src/agents.js:220`), with `bash` for the codegraph card
  (map `:606-610` denies `edit`, not `bash`; the card is offered where `bash` resolves
  allowed, `src/codegraph.js:77-81`) and `write` for one result file under `work/` (`:225`).
  Its reply is a location list or a summary; it has no form for a claim verdict.
- Debugger reproduces failures, writes repro scripts and notes under `work/debug-<topic>/`
  (`src/agents.js:144`, map `:518` denies `edit` only) and names the `pw` browser CLI
  (`:145`: "For runtime errors in a web page use the pw CLI from bash (`pw start`, `pw goto`,
  `pw screenshot`, `pw evaluate`, `pw stop`)"). `pw` is shipped by this plugin —
  `"pw": "./bin/pw.js"` (`package.json:14`), a Playwright daemon over `playwright-core`
  (`"playwright-core": "^1.62.1"`, `package.json:61`). It reaches every subagent's shell
  through the plugin's `shell.env` hook (§5.3); the installer's shim,
  `installShims(["pw", "gen"])` (`bin/install.js:321`), writes into `~/.local/bin`, and on
  this host that shim is absent (`ls ~/.local/bin/pw`: "No such file or directory"), so
  outside a subagent's shell `command -v pw` answers nothing. The browser `pw` needs is there:
  `chromiumInstalled()` of `bin/chromium.js` resolves the plugin's `playwright-core` Chromium
  under `~/.cache/ms-playwright/`.
- Gitter has `edit: "deny", write: "deny"` (`src/agents.js:593`) and bash; it carries out
  commits, pushes and reports exactly as briefed (`:211-216`). The build/rsync/re-pin/install
  half of a release is the releaser's (§6).
- Reviewer reviews after the fact. Its map is `{ ...SUBAGENT_NO_DELEGATION, ...NO_WEB_ACCESS }`
  (`src/agents.js:526`), so it holds `bash`, and its prompt uses it for one command: "Run
  `git diff <range>` (or `git diff --staged`) and review the changed lines and the code they
  call" (`:152`). It reviews what was built, not what a briefing claims before building.
- Arithmetic is the `calc` tool's (§3), held by every role.

### 1.7 `pw`: one daemon per session, a console record, no download

- The socket, pid and log names carry the session: `pwPaths(RUNTIME_DIR,
  process.env.PW_SESSION)` (`bin/pw.js:61`) gives `pw-<id>.sock/.pid/.log` with the id
  sanitised to `[A-Za-z0-9_-]` and cut to 64 characters (`bin/pw-lib.js:19-40`), and
  `pw.sock/.pid/.log` without one, under `XDG_RUNTIME_DIR` or `~/.cache`, in
  `opencode-agent-intercom/` (`bin/pw.js:53-58`). A verifier and a debugger running at once
  drive two daemons; a second `pw start` in the same session fails with "daemon already
  running" (`bin/pw.js:92`).
- The daemon records browser output: `page.on("console")` and `page.on("pageerror")` push
  `[<type>] <text>` and `[pageerror] <message>` into a ring of 500 lines (`bin/pw.js:319-320`,
  `CONSOLE_RING_LINES = 500`, `bin/pw-lib.js:16`); `pw console [--clear]` prints and optionally
  empties it (`bin/pw.js:208-211`).
- Screenshots: `case "screenshot": … return { cmd, path: path.resolve(args[0]), fullPage:
  args.includes("--fullPage") }` (`bin/pw.js:200-203`).
- `pw start` never downloads a browser: `requireInstalledBrowser` (`bin/pw.js:120-135`) asks
  `chromiumInstalled()` (which honours `PLAYWRIGHT_BROWSERS_PATH`) and, where playwright-core
  or the Chromium binary is missing, prints the one line
  `pw: browser not installed — report this check as NOT RUN` (`PW_BROWSER_MISSING_LINE`,
  `bin/pw-lib.js:10`) and exits 1 before any daemon starts. The daemon's own missing-binary
  guard prints the same line (`bin/pw.js:302`). Chromium is put in place by the installer
  `npx opencode-agent-intercom-install` (`ensureChromium`, `bin/install.js:301-310`).
- A daemon exits on its own after `PW_IDLE_EXIT_MS` without a request (default 900000, `0` =
  never; `bin/pw-lib.js:13`, `bin/pw.js:62`, `:322-332`).

### 1.8 How an image reaches the model in opencode

- opencode's `read` tool returns an image file as an attachment, not as text: for
  `SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])`
  (`opencode/src/tool/read.ts:19`) it answers "Image read successfully" with
  `attachments: [{ type: "file", mime, url: \`data:${mime};base64,…\` }]`
  (`opencode/src/tool/read.ts:306-323`).
- The provider on this host is `@ai-sdk/openai-compatible` (`opencode.json`,
  `provider.cliproxy.npm`). For that family `supportsMediaInToolResult` answers `false`
  (`opencode/src/session/message-v2.ts:147-163` names anthropic, openai, bedrock, xai,
  vertex-anthropic, google only), so the image is lifted out of the tool result into a
  synthetic user message opened by "Attached media from tool result:"
  (`opencode/src/session/message-v2.ts:46`, `:302-307`, `:386-396`).
- That user message then passes `unsupportedParts`: where
  `model.capabilities.input[modality]` is false the image is replaced by the text
  "ERROR: Cannot read … (this model does not support image input). Inform the user."
  (`opencode/src/provider/transform.ts:409-440`).
- `capabilities.input.image` comes from the config: `image:
  model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ??
  false` (`opencode/src/provider/provider.ts:1528`). In the user's `opencode.json` the cliproxy
  models `gpt-6-sol`, `gpt-6-luna` and `gpt-5.6-luna` carry `"modalities": {"input": ["text",
  "image"]}`; `mimo-v2.6-pro` and every `qwen3.8-*` carry no `modalities` key and so read as
  no image input.
- A compacted tool result loses its media: `const attachments = part.state.time.compacted ||
  options?.stripMedia ? [] : …` (`opencode/src/session/message-v2.ts:300`).
- The same capability block is what the TUI badge reads: `vision:
  m?.capabilities?.input?.image === true` (`tui/src/tui.tsx:754`), from
  `api.client.config.providers()` (`tui/src/tui.tsx:726`).
- The plugin sees the running model per request: the hook
  `"experimental.chat.system.transform"` receives `input: { sessionID?: string; model: Model }`
  (`plugin/src/index.ts:291-292`), and the plugin wires it to `transformSystem`
  (`src/index.js:283-284`, `src/hooks.js:458`). A hook `"shell.env"` with `input: { cwd,
  sessionID?, callID? }` and `output: { env }` exists (`plugin/src/index.ts:270-273`), and
  opencode merges its `env` over `process.env` for every shell tool call
  (`opencode/src/tool/shell.ts:416-425`); the plugin registers it (`src/index.js:354-356`,
  §5.3).

## 2. Verdicts at a glance

| # | wish | verdict | kind |
|---|---|---|---|
| 1 | runtime verifier | role `verifier` with vision: executes the artefact, screenshots it through the plugin's own `pw`, reads the screenshot and judges it; vidl states in its `AGENTS.md` how its artefact is served. The checker is the role for named check commands | plugin role + `pw` repair + project matter |
| 2 | premise attacker | role `refuter` (decided): checks a numbered claim list against the tree and answers each claim holds / false / not checkable, with codegraph `callers`/`impact` for "all"/"only" claims; the scout is the locator and summariser. A premise rule in `ORCHESTRATOR_PROMPT` sends unproven facts to it; the coder's one premise line reports a contradiction it meets with `ask` and checks nothing itself | plugin role + prompt |
| 3 | number oracle | **no role**: a plugin tool `calc(expression)`, pure and deterministic, held by the orchestrator and every subagent (decided) | plugin tool |
| 4 | release/publish | role `releaser`, holding `edit` (decided), that carries out a procedure file the project owns, exact-brief like the gitter: every commit message stands in the file or the briefing; the vidl chain itself is vidl's (turn `notes/wasm-publish-loop.md` into a procedure file/script) | plugin role + project matter |
| 5 | cost/slot guard | **no role**: the run ceiling decoupled from the silence window, a pre-spawn checklist in `ORCHESTRATOR_PROMPT`; one slot pool and the cap (built-in 1, live 6; decided); the user's file has retention back and per-role run ceilings. The documenter has no researcher edge (§7.3) | mechanism + prompt + user settings |

## 3. Wish 3 first: `calc` — a tool, not a role

It comes first because wishes 2 and 5 name it.

### Options

| | A: tool `calc` on primary and subagents | B: role `calculator` (bash, cheap model) | C: nothing; coder or scout carries it |
|---|---|---|---|
| cost per use | zero model tokens, milliseconds, no slot | one run: spawn round-trip, cheap-model tokens, one slot for its seconds, a wake | a model turn inside a run already paid for, and a spawn where none is running |
| correctness | exact by construction for doubles; flags past 2^53 | only as good as the model's use of bash; a model may answer from its head | same as B |
| forecloses | nothing; the primary stays unable to touch the project (no fs, no process, no network) | nothing | — |
| demands | a parser (no `eval`), one allowlist entry, one guide line, re-pinning the contract fixture | a role, a prompt, a pin, every hand-kept list of §1.1 | — |
| slot pressure (wish 5) | removes the runs | adds runs | — |

**Decided: A, with the orchestrator included** (user). The wish is the orchestrator's own: it
wants to check a figure it already holds (a budget, a byte count, an offset) without paying a
run. A tool is the only form that is "seconds-cheap". It widens `PRIMARY_TOOLS` by a function
that reads nothing and writes nothing, so "the primary does no project work" still holds.
Numbers that first have to be read out of the tree are not calc's: they come from a `scout`,
or as a claim to check from a `refuter` (§4), both of which hold `calc`.

### Built

- **Module** `src/calc.js`: `evaluateCalc(text)` (`:411`, pure, never throws),
  `formatCalcValue` (`:393`), `isCalcEnabled` (`:449`) and `createCalcTool()` (`:453`), which
  wraps it with `tool` from `@opencode-ai/plugin` (the pattern of `createForumSearchTool`,
  which imports `tool` at `src/forumsearch.js:38` and builds it at `:228`). Registered in
  `createTools` after the web tools (`src/tools.js:1798-1804`) as
  `...(isCalcEnabled() ? { calc: createCalcTool() } : {})`, kill switch
  `OPENCODE_AGENT_INTERCOM_DISABLE_CALC=1`, in both agent modes.
- **Argument**: `expression: string` — one or more statements separated by `;` or newlines.
- **Grammar** (`src/calc.js:12-24`): statement `name = expr` or `expr`; numbers decimal with
  `_` separators, exponent, `0x`/`0b`; suffixes `k M G T` (×1000ⁿ) and `Ki Mi Gi Ti` (×1024ⁿ);
  operators `+ - * / // % **`, unary minus, parentheses; one comparison `< <= > >= == !=` per
  statement yielding `true`/`false` ("does 204k fit under 200k"); a chained comparison is
  refused ("compare two values at a time; split a chained comparison"); functions `min max abs
  floor ceil round sqrt log2 log10 ln pow`; names bound by earlier statements. `**` is
  right-associative and binds tighter than a unary minus on its left (`-2**2` is -4); `//`
  floors and `%` takes the divisor's sign. Hand-written recursive-descent parser: no `eval`,
  no `Function`, no property access; bindings live in a `Map`, so `constructor`,
  `__proto__` and `process` are unknown names.
- **Bounds**: input ≤ 4000 characters, ≤ 100 statements, nesting depth ≤ 64
  (`src/calc.js:42-44`). Anything past them, and every parse or domain error (division by
  zero, unknown name, `sqrt` of a negative, a logarithm of a value ≤ 0), comes back as the one
  line `calc: <message> at column <n>`, the column counted from 1 over the whole input, and no
  partial result — the tool never throws into the model, so a weak model reads what to correct
  and calls again.
- **Output**: one line per statement, `name = value` or `value`; an integer exact in decimal,
  with a grouped form where |x| ≥ 1000 and hex where |x| ≥ 256 (`204k` →
  `204000 (204_000, 0x31CE0)`); other numbers to 15 significant digits (`0.1+0.2` → `0.3`);
  a literal, intermediate, result or used binding beyond `Number.MAX_SAFE_INTEGER` marks the
  statement `(not exact: beyond 2^53)`, and a name bound from it carries the mark on.
- **Permission**: `calc` is a member of `PRIMARY_TOOLS` (`src/hooks.js:180-204`), which holds
  six names: `spawn`, `abort`, `list`, `message`, `reuse`, `calc`; `availablePrimaryTools()`
  leaves it out of the refusal text under the kill switch (`src/hooks.js:303-308`). No role's
  map denies it, so every subagent holds it by absence, `grounder` included (it reads
  nothing). The orchestrator's own `permission` map (`src/agents.js:479-491`) has no `calc`
  entry (absence is the grant there as everywhere).
- **Protocol line** in `ORCHESTRATION_GUIDE` after the `list()` line (`src/prompts.js:38`),
  ~36 tokens:
  `- calc(expression) — exact arithmetic on figures you already hold (sizes, budgets, offsets, token sums). Answers at once and starts no subagent.`
  The following line "Every other tool is disabled." (`src/prompts.js:39`) stays true.
- **Contract**: the line matches the `spawn-protocol` selector, so the fixture
  `test/fixtures/prompt-contract.json` is re-pinned with it. `PROMPT_CONTRACT` is `2`
  (`src/prompts.js:247`): a user prompt file without the line describes an orchestrator that
  does not know one tool, which breaks nothing the contract exists for ("bumped BY HAND
  whenever one of them changes in a way that requires something new of a prompt file",
  `src/prompts.js:235-236`).
- **Role line** `src/agents.js:48`:
  `You delegate work to subagents. Your tools: spawn, message, abort, list, calc.`
  `reuse` stays out of it: the static prompt is shown with retention off as well, and the
  drift guard (`test/role-briefs.test.js:105-117`) keeps `reuse` in
  `ORCHESTRATION_REUSE_GUIDE` alone. The same guard fails on a `PRIMARY_TOOLS` member without
  a mention in the role line, so `calc` needs no test of its own there.

### Tests

- Unit `test/calc.test.js`: operators, precedence (`2+3*4**2`), `//` and `%` on negatives,
  literals, suffixes, functions and arity, comparisons, bindings across statements, output
  forms, the 2^53 mark and its propagation, errors with their column, the forbidden names
  `constructor`, `__proto__`, `process`, the three bounds, the tool output, registration and
  the kill switch, solo mode.
- Unit, orchestrator: the primary guard admits `calc` and refuses `read` with `calc` named
  among the tools it does have (`test/plugin.test.js`); every installed role's permission
  leaves `calc` undenied; `ORCHESTRATION_GUIDE` carries the `- calc(` line; the orchestrator
  and solo tool maps both hold it (`test/agent-mode.test.js`); the refusal lists of
  `test/retention-latch.test.js` name it; the drift guard of §1.5 covers the role line.
- No e2e: the tool calls no model.

## 4. Wish 2: the premise check — the role `refuter`

### Options

| | A: separate role that checks claims | B: the `scout` gets a second reply form, the claim check | C: coder checks its own premises first (prompt only) |
|---|---|---|---|
| cost | a role, a prompt, a pin, the hand-kept places of §1.1, a separate dispatch choice for the orchestrator | ~150 tokens more in every scout run, lookups included; no new role | zero extra runs; the check runs on the coder's expensive tier |
| catches | a false premise before a coder is briefed on it | same as A | a false premise inside the coder run, after the run is paid |
| tools for a universal claim ("all paths closed") | `bash` for `codegraph callers`/`impact` — the card is offered only where `bash` resolves allowed (`src/codegraph.js:77-81`) — and `outline`; the scout's map gives both (`src/agents.js:606-610`, not in `OUTLINE_DISABLED_AGENTS`) | the scout holds them | the coder holds the same tools |
| weak model | each prompt carries one job and one reply form; the orchestrator's pick is by the briefing's shape (a question vs. a numbered claim list) | one prompt, two reply forms, selected by the briefing's shape | nothing to choose |
| forecloses | nothing | a scout prompt that stays single-purpose | nothing |

**Decided: A** (user, 2026-09-29), plus C's one line worded so that the coder checks nothing
itself. The scout keeps one job and one reply form, which is what a `qwen3.8-flash-medium`
model follows best; the claim check has its own prompt, its own reply form and its own name in
the pick line, and the concept has one owner for claim verification. C is the backstop for
what the orchestrator did not send to the refuter: a coder that meets a file contradicting its
briefing asks, and gets its correction inside the same run.

### The name

| name | reads as | collides with |
|---|---|---|
| **`refuter`** | the one who tries to refute a claim — the premise attacker of the wish, in one word | nothing: no role shares a stem with it |
| `falsifier` | same meaning | nothing, but a rarer word for a weak model, and close to "falsify" in the sense of forging |
| `factchecker`, `claimchecker` | clear | `checker` — a weak orchestrator reads the stem and picks the wrong one |
| `prover` | the opposite stance: it looks for support, which is the bias the wish is against | nothing |
| `verifier` | — | taken by §5 |

**Chosen: `refuter`.** It names the stance the prompt asks for — look for the proof that a
claim is false — and a claim that survives that search is the one a coder may be briefed on.

### Role entry (after `scout` in `AGENTS`, `src/agents.js:613-627`)

```js
refuter: {
  description:
    "Checks a numbered list of claims about this code against the tree and gives each one a verdict — holds, false or not checkable here — with the path:line that decides it. Looks for the proof that a claim is false; for a claim with all, only or every it searches the whole tree. Changes no file.",
  mode: "subagent",
  hidden: true,
  // `bash` is granted for the codegraph CLI (callers, impact), `write` for the
  // one result file its prompt keeps under `work/`; `edit` is denied, so
  // existing files are not its to change. `outline` stays: it reads code.
  permission: {
    ...SUBAGENT_NO_DELEGATION, ...NO_SPAWN, ...NO_WEB_ACCESS,
    edit: "deny",
    todos_open: "deny", todo_done: "deny", todo_add: "deny", todo_edit: "deny",
  },
  prompt: REFUTER_PROMPT,
},
```

The map is the scout's (`src/agents.js:606-610`) key for key: `bash`, `read`, `grep`, `glob`,
`outline`, `write` and `calc` are granted by absence; `edit`, `spawn`, the web tools and the
four todo tools are denied. What that gives it, gate by gate:

- **Spawn**: none. `NO_SPAWN` in the map, no key in `NESTED_SPAWN_TARGETS`
  (`src/agents.js:350-357`), so `installAgents` forces `spawn: "deny"` as well
  (`src/agents.js:997-999`) and the prompt gets `SUBAGENT_NO_SPAWN_GUIDE`
  (`src/prompts.js:594`). The `NO_SPAWN` comment names it among "scout, refuter, checker,
  verifier — the lookup, claim-check, check and runtime-check roles" (`src/agents.js:312-316`).
- **Who spawns it**: the orchestrator alone. It is nobody's nested target ("`scout`,
  `refuter`, `checker` and `verifier` are targets of nobody … Only the orchestrator spawns
  them.", `src/agents.js:338-342`). A planner that wants a claim checked names it in its
  reply; the orchestrator sends it on.
- **Outline and codegraph**: not in `OUTLINE_DISABLED_AGENTS` (`src/prompts.js:373`), so
  `guideBlocks` appends `SUBAGENT_OUTLINE_GUIDE + codegraphCard` for it (`src/prompts.js:595`);
  the card appears where the codegraph command resolves and the role's `bash` resolves
  allowed (`codegraphCommandFor`, `src/codegraph.js:77-81`). Where neither card nor index is
  there, grep over every spelling is its search for a universal claim.
- **AGENTS.md**: stripped, like the scout's ("researcher / grounder / designer / gitter /
  scout / refuter strip it: … a code lookup and a claim check don't need project code
  conventions", `src/hooks.js:342-345`); not in `AGENTS_MD_SUBAGENTS` (`src/hooks.js:348-355`)
  nor `HAS_AGENTS_MD` (`src/promptsfile.js:91-99`). A claim about a project convention is
  checked against the file that states it, which the refuter reads like any other.
- **TODO tools**: none; the comment "Researcher, grounder, documenter, gitter, scout, refuter,
  checker, verifier and releaser never touch TODO.md." (`src/agents.js:98-99`) names it.
  `TODO_AGENTS` (`src/hooks.js:323-325`) is unchanged.
- **Reply ceiling**: `write` held, so `roleHoldsWrite` (`src/agents.js:401-403`) gives it the
  file form of `replyCapBlock` (`src/prompts.js:410`).

### Prompt (`REFUTER_PROMPT`, `src/agents.js:227-237`, beside `SCOUT_PROMPT`; ~235 tokens)

```
# Role: Refuter (Subagent)

Your briefing lists claims about this code. Check each one: look for the proof that it is false. Leave existing files as they are.
Search with grep, outline and read, and with codegraph where it is described below. For a claim with "all", "only", "every", "never" or "no other", search the whole tree: codegraph callers or impact, and grep for every spelling.
Compare figures with calc.
Give each claim one verdict:
- holds — the path:line that shows it;
- false — the path:line that contradicts it, and what stands there;
- not checkable here — it is about runtime, the web or another machine; name who checks it: verifier for runtime, researcher for the web.
Reply: first line `Claims: <n> — <h> hold, <f> false, <u> not checkable`, then one line per claim: `<#> <verdict> — <path:line> — <what is there>`.
Where the list is longer than your reply allows, write it to one file under `work/` and name that path.
```

The last line is the scout's and the checker's own (`src/agents.js:225`, `:247`), so the three
narrow roles file overflow alike.

### Dispatch (in `ORCHESTRATOR_PROMPT`, `src/agents.js:49-56`)

- "Available subagents" (`:49`) names `refuter` after `scout`.
- Pick (`:50`), after the scout's: "refuter to check facts before you brief them — send them as
  a numbered claim list".
- Rule, its own line after the pick line (`:51`): "Before you brief a coder or debugger on a
  fact about the tree that no subagent showed you in this session, send it to a refuter as a
  claim and brief with the verdict."
- Usual order (`:56`): "feature: planner → refuter (claims) → coder per task → …" — the claim
  step stands only in the feature line; a bug starts at the debugger, which reproduces.
- "If you are not sure, ask a scout first." (`:50`) stays: a question goes to the scout, a
  claim to the refuter.

### Coder backstop (`CODER_PROMPT`, `src/agents.js:122-137`)

One line after "Read a file before editing it; …" (`:128`), at `:129`: "Where a file you read
contradicts a fact in your briefing, `ask` your caller with the fact and the path:line; the
answer lets you go on." It asks the coder to report what it meets while reading, not to search
for proof — the search is the refuter's. `SUBAGENT_GUIDE_CORE` already sends an unanswered
`ask` to `Blocked:` ("where you already asked and no answer came"), so the line needs no stop
clause of its own.

### Settings, tier, budget

- `DEFAULT_AGENT_CONTEXT.refuter = 100000`, both copies (`src/settings.js:141`,
  `tui/src/agent-roles.ts:97`), like the scout's (`src/settings.js:140`).
- Model: `cliproxy/qwen3.8-flash-medium`, the scout's and checker's, pinned in
  `llm-models.json:46-49` (U1) — reading and searching with the judgement a universal claim
  needs.
- `E2E_PINNED_AGENTS` (`test/e2e/config-isolation.sh:108`) holds `refuter`.
- One slot pool, as every role (§7.4).
- User's file: `agentRunMs.refuter = 900000` (15 min), `resultTokens.refuter = 1500` (U2).

### Tests

- Unit `test/role-briefs.test.js`: the two loops "the narrow roles are spawnable by the
  orchestrator alone and spawn nothing" (`:278`) and "the narrow roles hold bash and write for
  work/, no edit, no web, no TODO tools" (`:289`) run over `scout`, `refuter` and `checker`;
  "the orchestrator sends claims to the refuter and briefs with its verdict" (`:318`); "the
  refuter gives each claim one verdict with the path:line that decides it" (`:351`: the reply
  line, the three verdicts, the universal-claim line naming `callers or impact`, `calc`); "the
  refuter reads code: outline, the codegraph card, no AGENTS.md" (`:363`); `SCOUT_PROMPT`
  carries no `Claims:`; "the coder asks about a briefed fact the tree contradicts and checks
  nothing itself" (`:373`).
- The literal side lists `NON_DELEGATING_ROLES` (`test/nested-delegation.test.js:71`,
  `test/nested-spawn.test.js:60`, `test/plugin.test.js:603`) hold `refuter`; the parity tests
  and the role-list tests of §1.1 pick it up.
- E2E `test/e2e/refuter-task.sh` (prefix `21-refuter`), on the suite server of
  `test/e2e/run-all.sh:184`, sessions against this repository: three claims — one true
  (`DEFAULT_MAX_NESTED_SPAWNS` is 2 in `src/settings.js`), one false (a constant that stands
  nowhere in the tree is exported from `src/settings.js`; the driver assembles its name at run
  time so it does not carry it), one universal and false ("only `src/tools.js` calls
  `spawnCapDecision`" — `test/entry-lifecycle.test.js` and `test/nesting-fixes.test.js` call
  it too). A preflight re-derives that ground truth and exits 2 where the tree moved.
  Criteria: `spawned`; `head` — the reply opens with
  `Claims: 3 — 1 hold, 2 false, 0 not checkable`; `claim-1` holds; `claim-2` false with a
  path:line; `claim-3` false with a path:line outside `src/tools.js`; `untouched` — no file of
  the repository changed outside `work/`, `test/e2e/out/` and `.opencode/`, the project
  documents the plugin writes where they are absent (PROJECT.md, ARCHITECTURE.md, TODO.md,
  `rr_plugin_scaffold`) left out; `model-pin` — every captured assistant turn ran on
  `E2E_MODEL`.

## 5. Wish 1: `verifier` — execute the artefact, look at it, never infer

### Options for the role

| | A: new role `verifier` | B: widen `checker` to run the artefact | C: widen `debugger` to verify | D: coder prompt demands running the artefact |
|---|---|---|---|---|
| cost | one run after a build | none extra | none extra | none extra |
| outcome | a PASS/FAIL/NOT RUN per check with the command and the observed output, a screenshot judged by the verifier itself | the checker reports exit codes and counts of commands it runs "as the briefing names it" (`src/agents.js:242`); a browser session, screenshots and a judgement of what is on screen are a different deliverable, and they need a vision tier where the checker is pinned to `qwen3.8-flash-medium`, which declares no image input | the debugger's prompt is a diagnosis of a known failure ("you do not fix it", "find the root cause", `src/agents.js:141`); a verification of a claimed success is a different deliverable in the same role | the coder already "runs build and tests" (`src/agents.js:132`) and in vidl its tests run a stub (§1.6) — the incentive to call its own work verified stays with the one who built it |
| forecloses | nothing | a checker prompt short enough for its `qwen3.8-flash-medium` pin | a clean debugger contract | nothing |

**Chosen: A.** The failure in the wish is structural: the builder verified with a runtime
(bun) that does not load the artefact. A role whose only deliverable is observed behaviour in
the artefact's target runtime, and which may not edit the source, is the one arrangement in
which "I reasoned it works" cannot pass as a result. Seeing the rendered page is part of that
observation: a canvas-drawn wasm view has no DOM text a script could read back, so without
vision the verifier could only report "no console error", which is not what the user looks
at. The checker keeps the named check commands; the two split cleanly by what is observed — a
command's printed result, or the artefact running.

### Role entry (after `checker` in `AGENTS`, `src/agents.js:643-660`)

```js
verifier: {
  description:
    "Executes a built artefact in the runtime it targets — a page in a real browser, the binary, the installed package — screenshots what it renders and judges the screenshots itself; reports what it observably does. A check it could not execute or could not see is reported as not run. Named test, lint and build commands are the checker's.",
  mode: "subagent",
  hidden: true,
  permission: {
    ...SUBAGENT_NO_DELEGATION, ...NO_SPAWN, ...NO_WEB_ACCESS,
    edit: "deny", outline: "deny",
    todos_open: "deny", todo_done: "deny", todo_add: "deny", todo_edit: "deny",
  },
  prompt: VERIFIER_PROMPT,
},
```

`bash` granted (it executes), `read` granted (it is how a screenshot reaches the model,
§5.2), `write` granted without a limit (decided, user 2026-09-29): harness files, screenshots
and its result file go where the run needs them; neither `guardToolExecute`
(`createGuardToolExecute`, `src/hooks.js:2836`) nor the prompt holds them to `work/`.
`roleHoldsWrite` (`src/agents.js:401-403`) gives it the file form of the reply-ceiling blocks.
`edit` denied (no change to existing files — soft against a model that uses `bash` to edit,
like every edit denial on a bash role, e.g. debugger `src/agents.js:518`; the prompt carries
the rule). `outline` denied and the role in `OUTLINE_DISABLED_AGENTS` (`src/prompts.js:373`),
for the checker's reason stated there: it reads what the artefact does, not the code behind
it, so neither the outline block nor the codegraph card is carried. In `AGENTS_MD_SUBAGENTS`
(`src/hooks.js:348-355`, "verifier keeps it: how the project builds, serves and starts its
artefact stands there", `:335-336`) and its offline mirror `HAS_AGENTS_MD`
(`src/promptsfile.js:91-99`).

### 5.1 The model must see images

Vision is a property of the model the verifier runs on, and the pin lives in the user's
`llm-models.json` (§0). The plugin cannot make a model see; it can pick the tier, say what
happens on a model that cannot, and make it visible.

Tier: `cliproxy/gpt-6-luna` — declared `"modalities": {"input": ["text", "image"]}` in the
user's `opencode.json` (§1.8), pinned for the verifier at `llm-models.json:50-53`. The
verifier's judgement is bounded by its briefing — each check states what is expected on
screen — so it compares, it does not design. `gpt-6-sol` is the heavy option. `mimo-v2.6-pro`
is **not** usable as the config stands: it carries no `modalities` key, so opencode reads it
as `image: false` (`opencode/src/provider/provider.ts:1528`) and replaces every screenshot with
the ERROR text (`opencode/src/provider/transform.ts:439`) whatever the model upstream can do;
adding `"modalities": {"input": ["text", "image"]}` to its entry in `opencode.json` is the
user's change (U3) and makes it eligible. No `qwen3.8-*` model declares image input.

What the plugin does where the verifier runs on a model without image input:

| | A: warn at load | B: refuse the spawn | C: tell the verifier per request, show it in the sidebar |
|---|---|---|---|
| mechanism | at plugin load, resolve the verifier's pin, look it up in `client.config.providers()`, log a line | the spawn handler resolves the pin and its capabilities before creating the session; refusal text to the orchestrator | `transformSystem` reads `input.model.capabilities.input.image` (§1.8) for a subagent whose role is in `VISION_ROLES`; where it is not `true` it appends `VERIFIER_NO_VISION_LINE`; the TUI model row renders a note for a vision role on a non-vision model |
| what the model actually running sees | nothing — the log is not in any prompt | no run | the rule that turns a screenshot check into NOT RUN |
| accuracy | the pin, not the model that runs (an unpinned verifier falls to opencode's default model, which the pin lookup does not see) | same as A, plus an async provider call inside the spawn mutex path | the model of THIS request, pinned or not |
| forecloses | nothing | every non-visual verification (a CLI, a binary's exit code, an installed package's import) on a text model | nothing |
| demands | a load-time async call, a log line nobody reads | a lookup in the spawn path, a refusal text, a test per branch | a role set, one line in `transformSystem`, one constant, a TUI note, tests |

**Chosen: C.** It is exact (the capability of the model the request runs on, which is also
what opencode itself uses to drop the image), it costs one property read per request, and it
keeps the honesty rule of the role intact: a check the verifier could not see is `NOT RUN`,
never `PASS`. It also keeps the run useful — every check that needs no eyes is still carried
out — where B would give the orchestrator nothing. The sidebar note is the visible half of A
without A's blind spot.

Built:

- `export const VISION_ROLES = Object.freeze(["verifier"])` (`src/agents.js:686`), apart from
  the `AGENTS` entries for the same reason the comment there gives (an entry is spread into
  opencode's `config.agent`, `src/agents.js:961-962`, `:1023`, so a plugin-only key there
  would reach opencode's agent schema). TUI copy `tui/src/agent-roles.ts:106`, held by
  `test/settings-defaults-parity.test.js`.
- `VERIFIER_NO_VISION_LINE` (`src/prompts.js:379-380`), ~27 tokens:
  `Your model cannot see images. Mark every check that needs a look at a screenshot NOT RUN, reason: no vision.`
- `noVisionLineFor(entry, model, sessionID)` (`src/hooks.js:443-455`): for a role in
  `VISION_ROLES` whose `model?.capabilities?.input?.image !== true` — a missing model counts
  as unable to see — it answers the line; the first hit per entry is logged
  `vision role on non-vision model` with `sessionID`, `agent` and `providerID/id`
  (`entry.noVisionLogged`). `transformSystem` reads it for a subagent (`src/hooks.js:790`) and
  pushes it as its own element of `output.system`: after the stable element and before the env
  slice on the auto path (`:840`), after the template element on the custom-template path
  (`:810`). It rides in the system prompt, not in a per-turn notice: the model of a session
  does not change between its turns, so the prefix cache holds.
- TUI: `visionNote(agent, visionBadge)` (`tui/src/agent-roles.ts:112-115`) answers
  `needs a vision model (V)` for a role in `VISION_ROLES` whose vision badge reads `-`, and
  nothing for `?`, for a model that sees or for another role; `tui/src/tui.tsx:2623` computes
  it and `:2677-2679` renders it beneath the model row, in the warning colour, indented under
  the value column.

### 5.2 How the screenshot reaches the model

The path is opencode's own and needs no plugin code: the verifier writes a PNG with
`pw screenshot <path>`, then calls `read <path>`; `read` returns the image as a `file`
attachment (§1.8), opencode lifts it into a user message for the openai-compatible cliproxy
provider, and the model sees it on its next step. Consequences the design takes on:

- **Formats**: PNG, JPEG, GIF, WebP only (`opencode/src/tool/read.ts:19`). `pw screenshot`
  writes PNG by the `.png` extension; the prompt names `.png`.
- **Cost**: every image sits in the context from then on. The budget is
  `DEFAULT_AGENT_CONTEXT.verifier = 100000`; a viewport screenshot costs on the order of a
  thousand tokens on the provider side (assumption, §11), so a run of a dozen screenshots
  stays well inside it. The prompt asks for viewport screenshots; `--fullPage` is the
  briefing's to request.
- **Compaction drops images** (`message-v2.ts:300`). The prompt therefore makes the verifier
  write down what it sees in the step right after reading the image, so the verdict survives
  where the pixels do not. Compaction is off by default for every role (`compaction` default
  `false`), and `agentCompaction.verifier` is unset.
- **No second channel**: a `browser-screenshot` tool that returns the image directly from the
  plugin was weighed — it would put a browser inside the opencode process and duplicate `pw`
  — and is not built; `pw` plus `read` carries it.

### 5.3 The browser the verifier drives: the plugin's own `pw`, made reachable

| | A: plugin puts `pw` on the subagent's `PATH` (`shell.env`) and isolates it per session | B: rely on the installer shim | C: the verifier writes its own Playwright script |
|---|---|---|---|
| change | `shell.env` hook; a shipped shim `bin/shims/pw`; `bin/pw.js` reads `PW_SESSION` for its socket, pid and log names; console and page-error buffer with `pw console` | the user runs `npx opencode-agent-intercom-install` on every host (`bin/install.js:321`) | none in the plugin; the prompt tells it to write a `node` script |
| cost | one hook, one small file, a pw change, tests | per-host setup that is missing on this host; one shared daemon | the plugin's `playwright-core` is not resolvable from the project's cwd; every run writes and debugs its own harness — tokens and failure modes on the cheap model |
| forecloses | nothing (a globally installed `pw` still works; the hook only prepends) | concurrent verifier + debugger | nothing |
| demands | that opencode calls `shell.env` for subagent bash calls (it does, `shell.ts:416-425`) | the user's step on each machine | a model that writes Playwright reliably |

**Chosen: A.** It makes the role work wherever the plugin loads, gives a weak model five fixed
commands instead of a harness to write, and repairs the debugger's `pw` on this host with the
same change.

Built:

- **Shim** `bin/shims/pw` (shipped, mode 755, in `files` through `bin`): `#!/bin/sh` +
  `exec node "$(dirname "$0")/../pw.js" "$@"`.
- **Hook** `"shell.env"` in `src/index.js:354-356`, body `shellEnvHook(input, output)` in
  `src/shellenv.js:21-38`: where `input.sessionID` is a session the registry tracks
  (`entryForSession`), `output.env.PATH = SHIM_DIR + delimiter + (output.env.PATH ??
  process.env.PATH)` — not prepended a second time — and `output.env.PW_SESSION = sessionID`.
  Every failure is caught and logged `shell.env hook error`. All subagent roles get it, so
  the debugger's prompt line holds too; the primary gets nothing (orchestrator mode has no
  `bash`; solo mode keeps the machine's `PATH` as the user set it).
- **Pure parts** in `bin/pw-lib.js`, apart because `bin/pw.js` dispatches at import time:
  `pwSessionSuffix`, `pwPaths`, `pwIdleExitMs`, `createConsoleRing`, `consoleLine`,
  `pageErrorLine`, `parseConsoleArgs` (`--clear` only), `formatConsoleRecord`
  (`(no console output)` when empty), `PW_BROWSER_MISSING_LINE`.
- **Per-session daemon**, **console record**, **no download** and **idle exit** as §1.7 states
  them. Two subagents run two daemons and cannot drive each other's page; a daemon whose run
  was cut off exits on its own after 15 min, so no plugin teardown path has to know about
  browsers.

### 5.4 Prompt (`VERIFIER_PROMPT`, `src/agents.js:249-262`, ~335 tokens)

```
# Role: Verifier (Subagent)

You run a built artefact and report what it does. Your briefing names the artefact and the checks.
Run it where it really runs: a web page in a browser, a program as the binary, a package as installed. AGENTS.md says how this project serves and starts it. A check you can only run through a test runner or a stub is a checker's: mark it NOT RUN, reason: checker.
For a web page use pw in bash: pw start, pw goto <url>, pw console, pw screenshot work/verify-<time>/<name>.png, pw stop.
Run pw with the environment as you find it, and use only the tools already installed here.
When pw start fails, that is the result of every browser check: write each one NOT RUN at once, with pw's error line as the reason, and go on to the next check.
Right after each screenshot, read the image file and write down what you see.
Leave existing files as they are. Stop every process and browser you started before you reply.
Per check give the command, its exit code, the evidence (a console line, a value, or what the screenshot shows and its path), and the verdict:
- PASS: you ran it and saw the expected result.
- FAIL: you ran it and saw something else.
- NOT RUN: you could not run it or could not see the result; give the reason.
Reply: first line `Checks: <n> — <p> pass, <f> fail, <r> not run`, then one line per check.
```

The prompt names `pw`: the plugin puts it on the verifier's `PATH` (§5.3), so it is the
plugin's fact, not the project's. The two `pw` rules hand a missing browser to the reply: `pw
start` answers `pw: browser not installed — report this check as NOT RUN` and exits 1 (§1.7),
and the verifier takes that line as the reason of every browser check rather than fetching,
re-pointing or launching a browser of its own. The screenshot path in the `pw` line is the one
place it names; it is an example a weak model can copy, not a rule for where files go — the
verifier writes wherever its run needs (§5 role entry). How the artefact is served and which
URL to open is the project's, in its `AGENTS.md`. The reply-ceiling block (`replyCapBlock`,
`src/prompts.js:410`) tells a `write`-holding role to file long output, so the prompt carries
no line of its own for it. On a model without image input the prompt is followed by
`VERIFIER_NO_VISION_LINE` (§5.1).

### Dispatch (`ORCHESTRATOR_PROMPT`)

Available (`src/agents.js:49`): `… checker, verifier, debugger …`. Pick (`:50`), after the
checker's: "verifier to run a built artefact where it really runs and look at the result".
Rule (`:52`): "A change that shows only at runtime is done when a verifier reports PASS for
it." Usual order (`:56`): "feature: … → checker → verifier where the change shows at runtime
→ reviewer → documenter and gitter; release: verifier → releaser."

### Settings, tier

- `DEFAULT_AGENT_CONTEXT.verifier = 100000`, both copies (`src/settings.js:143`,
  `tui/src/agent-roles.ts:99`).
- Model tier `cliproxy/gpt-6-luna` (§5.1), pinned in `llm-models.json:50-53`.
- User's file: `agentRunMs.verifier = 1800000` (30 min).

### Tests

- Unit `test/verifier-role.test.js`: entry shape and map (`bash`, `read`, `write` held;
  `edit`, `outline`, `spawn`, web and TODO tools denied); installed map with the forced spawn
  deny; the prompt lines verbatim, the `pw` line, both `pw` rules and no `Put every file`
  line; `VISION_ROLES` is the verifier, a spawnable role, and the TUI carries the same list;
  no outline block, AGENTS.md kept live and in its prompt file; a `write` outside `work/`
  passes the guard (the guard has no path rule, so the test pins that absence through
  `tool.execute.before`); the orchestrator's pick, runtime rule and release rule; the
  no-vision line — present as its own element and logged once on a model with
  `image === false`, absent with `true`, present with no model, absent for a coder on a
  non-vision model; the TUI model-row note for a verifier on a model with vision badge `-`
  and none otherwise (`:220`).
- Unit `test/shellenv.test.js`: a subagent session gets the shim directory first on `PATH` and
  its own `PW_SESSION`; a `PATH` already in the output is the one the shims go in front of;
  every subagent role gets it, the debugger included; a primary or unknown session's env is
  untouched; a throw is caught; the plugin registers the hook and the shim runs `bin/pw.js`.
- Unit `test/pw.test.js`: socket, pid and log names from `PW_SESSION` (sanitising, length cut,
  absent → `pw.sock`); `pw console` takes `--clear` and nothing else; the ring keeps the last
  500 lines; console and page-error line forms; the idle exit default and parsing; `pw console`
  with an unknown argument exits 2 without a daemon; `pw start` with no browser installed exits
  1 at once with the one line, empty stdout, no socket and nothing downloaded; two daemons with
  two `PW_SESSION` values against a `data:` URL that throws on load, the `[pageerror]` line
  read back from one and not the other (skipped with a reason where `chromiumInstalled()` says
  no).
- E2E `test/e2e/verifier-task.sh` (prefix `23-verifier`), wired into `test/e2e/run-all.sh:236`
  after the suite server stops. It owns its servers on `VERIFIER_PORT` (4614), because the
  verifier's model is an `llm-models.json` pin read at server start and leg 4 needs a server
  environment without a browser. The fixture, under a temp dir and committed to its own git
  repository, has an `AGENTS.md` that says "serve it with `python3 -m http.server <port>` from
  this directory, then open `http://127.0.0.1:<port>/index.html`"; the reply is read by
  `test/e2e/lib/verifier-reply.py`, which takes a verdict only where the reply form puts one.
  1. Server A, verifier on `E2E_MODEL` — leg 1: `index.html` loads `app.js`, whose code throws
     in the browser (`document.querySelector("#missing").textContent`) and which imports fine
     under node. Criteria: spawned, head, the check `FAIL` and no `PASS`, the `[pageerror]`
     line quoted, `pw start` answered in the verifier's shell (`pw: daemon started`).
  2. Server A — leg 3: `canvas.html` draws a red rectangle with the word `BROKEN` on a
     `<canvas>`, no DOM text; check "the page shows a green OK banner". Where `E2E_MODEL`
     declares no image input (`e2e_model_has_image_input`): `NOT RUN`, "no vision" given as
     the reason, no `PASS`; `SKIP` where it sees.
  3. Server B — leg 2: the same check with the verifier pinned to `E2E_VISION_MODEL` (form
     `provider/model`, taken as given; `e2e_resolve_vision_model`, `e2e_iso_pin_agent` in
     `test/e2e/config-isolation.sh`). Criteria: `FAIL`, a screenshot under
     `work/verify-*/` written after the leg started (`find -newer` a marker), the evidence
     naming red or `BROKEN`. `SKIP: no E2E_VISION_MODEL` where unset, never `PASS`.
  4. Server C — leg 4: the leg-1 check with `PLAYWRIGHT_BROWSERS_PATH` pointed at an empty,
     read-only directory and the isolated home's `.cache` rebuilt without `ms-playwright`
     (`vf_hide_browser_cache`), so `pw start` exits 1 with
     `pw: browser not installed — report this check as NOT RUN`. Criteria: `NOT RUN`, no
     `PASS`; `leg4 env` — no bash call clears or re-points `PLAYWRIGHT_BROWSERS_PATH` or runs
     `env -i` (`VF_ENV_ESCAPE`); `leg4 browser` — no bash call runs `playwright install` or
     launches a browser binary in command position (`VF_BROWSER_ESCAPE`).
  Over the run: `untouched` (no tracked fixture file changed) and, per leg, `model-pin` — every
  captured assistant turn on the model pinned for its agent, the verifier's own pin carried
  through `E2E_AGENT_PINS` into `test/e2e/lib/model-audit.py --agent-model`. Cleanup stops
  every process a verifier's shell left, found by its session's `PW_SESSION`
  (`rr_stop_session_procs`, `test/e2e/lib/role-run.sh:74`). No TUI build: `opencode serve`
  renders no sidebar.

## 6. Wish 4: `releaser` — carry out the project's procedure

### What is plugin matter and what is not

The chain "build wasm → rsync → commit → push → re-pin → install" is vidl's, and vidl
has it written: `/home/wu/vidl/notes/wasm-publish-loop.md` sets out five ordered steps,
including "Manually sync the generated package into `/home/wu/vidl-wasm`", "Push the
private-repo commit, re-pin both manifests, and run `bun install`", and "Never run two builds
concurrently: they share `rust/wasm/pkg`". The plugin cannot and should not know that chain.
What the plugin had to supply is a role that may carry out such a chain at all: gitter cannot
write (`src/agents.js:593`) and runs git operations only (`:211`), coder is scoped to "max ~100
lines of code change, 1–2 files" (`src/agents.js:125`).

### Options

| | A: new role `releaser` following a procedure file | B: widen gitter (drop `write: "deny"`, extend prompt) | C: project-only agent in vidl |
|---|---|---|---|
| cost | one role; its git steps share the gitter's text (below) | none new | none in the plugin |
| forecloses | nothing | gitter's exact-brief contract is one commit/push/report per briefing (`src/agents.js:211-216`); a multi-step build and sync chain inside it widens what a gitter run can do and what the orchestrator must brief | — not spawnable: the set is closed (`src/agents.js:713-717`) and a project agent is no spawn target |
| demands | a procedure file per project | same file | — |

**Chosen: A.** Gitter is the cheap single-purpose git role; the releaser takes the
multi-step, multi-repo run. It is an exact-brief role in the gitter's sense: the procedure
file is its brief, and it decides nothing the file does not state — the commit messages
included. Unlike the gitter it holds `edit` (decided, user 2026-09-29), so a procedure step
may be a hand edit — the vidl re-pin of two manifests as the note has it.

### Where a commit message comes from

The releaser runs on `gpt-6-luna` (§8 U1) and composes no commit message: the exact-brief rule
(`src/agents.js:57`) keeps that decision off the roles that carry a stated task out.

| | A: the procedure file states each message | B: the briefing states them (the orchestrator copies a coder's `Commit:` line) | C: the releaser composes them from `git log` and the diff |
|---|---|---|---|
| fits | fixed release commits ("re-pin vidl-wasm to <sha>") | a release that also commits a change a coder made | anything |
| weak model | fills a stated value in: `<value from step k>` is the output a named earlier step printed | copies text | composes in the project's style — the judgement the exact-brief rule takes away from this tier |
| forecloses | nothing | nothing | the exact-brief rule for this tier; style drift and forbidden trailers go unchecked |

**Chosen: A, with B for a change-carrying commit.** A commit step in the file names its files
and its message; where the message depends on a value (a hash, a version), it names the step
whose output supplies it. A commit of work a coder did carries the coder's `Commit:` line,
which the orchestrator copies into the releaser's briefing as it does for the gitter
(`src/agents.js:58`); the coder composes it "in the style of `git log -5 --format=%s` and the
commit rules in AGENTS.md/CLAUDE.md" (`:136`). A commit step with neither is a gap in the
brief: one `ask`, then the stop. C is rejected.

### Role entry (last in `AGENTS`, after `verifier`, `src/agents.js:661-677`)

```js
releaser: {
  description:
    "Carries out a project's release procedure file step by step — build, sync, edit, commit, push, re-pin, install — exactly as written, with the commit messages the file or the briefing states; checks each step as the file says and stops at the first failure. Changes a file only where a step says so.",
  mode: "subagent",
  hidden: true,
  permission: {
    ...SUBAGENT_NO_DELEGATION, ...NO_SPAWN, ...NO_WEB_ACCESS,
    outline: "deny",
    todos_open: "deny", todo_done: "deny", todo_add: "deny", todo_edit: "deny",
  },
  prompt: RELEASER_PROMPT,
},
```

`bash`, `write` and `edit` granted by absence (decided, user 2026-09-29). The re-pin in vidl
edits two manifests; the procedure file may state it as a hand edit (file, key, value) or as a
command, and the vidl note works as it stands. What this costs: the stop-at-first-failure rule
rests on the prompt alone — a releaser that edits could "fix" a failing step instead of
stopping at it, and nothing in the map prevents that (as `bash` would allow it on any role
anyway). The prompt answers it with two lines: a file changes only where a step says so, and a
failed step or check ends the run, whose reply then opens with `Blocked:`; the e2e below pins
both. In `OUTLINE_DISABLED_AGENTS` (`src/prompts.js:373`, like gitter; the parity test requires
the `outline` deny beside it) and in `AGENTS_MD_SUBAGENTS` (`src/hooks.js:348-355`, "releaser
keeps it: the project's build, commit and push rules stand there beside the procedure file it
carries out", `:337-338`) with its mirror `HAS_AGENTS_MD` (`src/promptsfile.js:91-99`).

### `GIT_STEPS` — one text for gitter and releaser, ~100 tokens

An exported constant `GIT_STEPS` (`src/agents.js:205-207`), interpolated into `GITTER_PROMPT`
(`:213`) and `RELEASER_PROMPT` (`:272`), so the two roles cannot drift apart:

```
Stage each named file with `git add <path>`, check the result with `git diff --staged`, then commit with the stated message word for word. Where the message holds `<value from step k>`, put in the value step k printed.
Push only the branch the task names; force-push only where the task says so.
On a pre-commit hook failure, reply `Blocked:` with the failure and the state left; the fix goes to another role.
```

The `<value from step k>` sentence holds for the gitter as well and is harmless there (its
briefs carry no placeholder). `GITTER_PROMPT` keeps its own scope line (`:211`), its
full-task line "For every commit the prompt hands you the full task: the exact files to stage,
the exact commit message, and whether to push." (`:212`), its ask line (`:214`), its forge-error
line (`:215`) and its report line (`:216`) around the interpolation.

### Prompt (`RELEASER_PROMPT`, `src/agents.js:264-277`, ~240 tokens plus `GIT_STEPS`)

```
# Role: Releaser (Subagent)

You carry out a release procedure file, step by step, exactly as written.
Use the file your briefing names, else RELEASE.md in the project root.
Run the steps in order. After each step, run the check the file gives for it.
Change a file only where a step tells you to, exactly as the step says.
Each commit step names its files and its message; a commit your briefing hands you takes the message the briefing gives. Where a commit has no message, ask your caller once with `ask`.
When a step or its check fails, or an asked question stays unanswered, stop there.
${GIT_STEPS}
Reply with one of these first lines:
- all steps done: `Release: done — <n> steps`
- stopped: `Blocked: release stopped at step <k> — <n> steps`
- no procedure file: `Blocked: no procedure file`
Then one line per step: `<k> <ok|fail|not run> — <command> — <check result>`, with commit hashes and pushed refs. After a stop, add the failed command's exit code and output.
```

The reply has one head per outcome, and every stop opens with `Blocked:`, so the plugin's
`isBlockedResult` and the orchestration guide read a stopped release as a decision handed up.
A check that no other build runs (vidl: "they share `rust/wasm/pkg`") is a step of the
procedure file with its own command, not a judgement of the releaser.

### Dispatch (`ORCHESTRATOR_PROMPT`)

Available (`src/agents.js:49`): `releaser` last. Pick (`:50`), after the gitter's: "releaser to
carry out the project's release procedure file (name the file; add the coder's `Commit:` line
where a change goes with it)". Rule (`:53`): "Start a releaser when no coder, debugger or other
releaser runs in the same project, and after the verifier's PASS where there is one." Usual
order (`:56`) ends "release: verifier → releaser". The exclusivity is a prompt rule; a spawn
gate that refuses a releaser beside an editing role in the same directory is the mechanical
alternative (cost: a directory-scoped scan in the spawn handler and a refusal text), held back
until a run shows the rule is ignored.

### Settings, tier

- `DEFAULT_AGENT_CONTEXT.releaser = 100000`, both copies (`src/settings.js:144`,
  `tui/src/agent-roles.ts:100`).
- Model tier `cliproxy/gpt-6-luna`, pinned in `llm-models.json:54-57` — instruction following
  over a stated command sequence; everything it would otherwise decide stands in the file
  (above).
- User's file: `agentRunMs.releaser = 5400000` (90 min) — the chain includes a wasm build,
  two pushes and an install.

### Tests

- Unit `test/role-briefs.test.js`: the releaser's map grants `bash`, `write` and `edit` and
  denies `outline`, `spawn`, web and TODO tools, in source and installed through
  `hooks.config`, `mayDelegate` false, no nested target (`:423`); it changes a file only where
  a step says so and stops at the first failure (`:453`); its reply has one head —
  the reply block verbatim, the only backticked heads are `GIT_STEPS`' `Blocked:` and the three
  reply forms, and no `Release: <done|stopped` head (`:463`); gitter and releaser carry out a
  commit by the one `GIT_STEPS` text, once in each (`:479`); the orchestrator's releaser pick
  and rule (`:490`); outline guide absent, AGENTS.md kept live and in its prompt file (`:497`).
- E2E `test/e2e/releaser-task.sh` (prefix `22-releaser`), on the suite server of
  `test/e2e/run-all.sh:185`: a fixture under a temp dir — a project whose `origin` is a local
  bare repository, holding `manifest.json`, `build.sh`, `announce.sh` and a `RELEASE.md` of six
  steps: 1 build (`sh build.sh` writes `dist/build.txt` and prints a version the driver drew),
  2 edit `version` in `manifest.json` by hand to `<value from step 1>`, 3 commit
  `manifest.json` with the message `release <value from step 1>`, 4 push `main` to `origin`,
  5 verify — its check expects `dist/release-notes.txt`, which no step makes, 6 announce
  (`sh announce.sh` writes `dist/announced.txt`). Criteria: `spawned`; `head` — the reply head
  is `Blocked: release stopped at step 5` (read by `test/e2e/lib/releaser-reply.py`); `steps` —
  1–4 `ok`, 5 `fail`, 6 `not run`; `remote` — `manifest.json` on `origin/main` carries the
  printed version; `subject` — the commit on `origin/main` carries exactly
  `release <printed version>`; `stopped` — `dist/announced.txt` does not exist; `no-fixup` —
  the file the failing check expects was not made; `scope` — the release commit touches
  `manifest.json` alone and the work tree holds nothing new outside `dist/` and `work/` beyond
  the project documents the plugin writes; `model-pin`. The fixture is removed unless
  `KEEP_FIXTURE=1`.

### Shared e2e ground

`test/e2e/lib/role-run.sh` runs one orchestrator turn that spawns one subagent of a named role
and follows it to its end (`rr_run_role`, `:123`), each call starting from empty outputs
(`rr_reset`, `:35`). `rr_read_reply` (`:206`) takes the subagent's reply from its wake notice in
the primary transcript (`test/e2e/lib/wake-reply.py`), then from the subagent's own capture
(`test/e2e/lib/final-reply.py`), then from the whole primary transcript, and names its source
in `RR_REPLY_SOURCE`. `rr_plugin_scaffold` (`:96`) names the project documents the plugin
writes where they are absent, taken before the run. `rr_session_pids`/`rr_stop_session_procs`
(`:56`, `:74`) stop every process whose environment holds the subagent's `PW_SESSION`. The
readers and these helpers are pinned by `test/e2e-role-readers.test.js`.

## 7. Wish 5: mechanisms, not a guard role

A guard **role** is rejected: vetting a spawn costs a spawn, it runs after the orchestrator has
already decided, and what it would need to judge "does this need a run" — what the
orchestrator already holds — lives only in the orchestrator's own context. The answer is the
run ceiling (§7.1) and a pre-spawn checklist (§7.2), with `calc` (§3) and the refuter (§4)
taking small work out of expensive runs and three user settings (§8 U2). The slot pool is one
(§7.4).

### 7.1 The run ceiling bounds on its own switch

| | A: decouple | B: keep, make it visible |
|---|---|---|
| change | `sweepWatchdog`: where `maxAge <= 0`, skip the silence and tool-call limits but still apply the run limit (`watchdogLimit` run kind, `src/watchdog.js:389-400`); `runCeilingNotice` without a `maxSubagentAgeMs` test | the sidebar's run row renders `off (silence off)` while `maxSubagentAgeMs` is 0 |
| cost | a user who switched the silence window off to avoid kills gets the 44-min ceiling; their way out is the run row's own `0` | none in behaviour |
| forecloses | nothing | a wall-clock bound for anyone who wants no silence window |

**Chosen and built: A** — the three rows are presented as independent and each has its own
`off`; the run ceiling is the only bound against the case in the wish, and its wrap-up band
(75 %) hands the subagent its two moves — `Blocked:` with what it has, or `ask` — before the
cut. The sweep reads `if (maxAge <= 0 && limit.kind !== "run") continue`
(`src/watchdog.js:184`); the comment at `:116-119` states "Inside the running branch it
switches off the silence and the tool-call windows and leaves the run ceiling standing", and
the one above `runCeilingNotice` (`src/hooks.js:1409-1412`) "The inactivity watchdog switched
off (`maxSubagentAgeMs <= 0`) leaves the run ceiling standing, so the band speaks there as
well." The retained-entry reap path is untouched (`maxSubagentAgeMs <= 0` "reaches the running
branch alone. It must not also switch off the reap", `src/watchdog.js:109-114`). The TUI run
row computes its two notes against an in-tool window of 0 where the silence window is 0
(`effectiveInToolMs`, `tui/src/run-ceiling-row.ts:43`) and so shows no line there.

Tests: `test/subagent-run-ceiling.test.js` — "with both older windows off the run ceiling still
reaps" (`:314`, `agentRunMs: { coder: 1000 }`, reaped with `setting: "maxSubagentRunMs"`), "a
type's run ceiling of 0 keeps its run unbounded with the older windows off" (`:339`), "a silent
entry with no run ceiling is not reaped while the silence window is off" (`:354`), "a call in
flight is not reaped on its own window while the silence window is off" (`:365`);
`test/run-wrap-up-band.test.js` — "the band fires at 0.75 with the silence window off"
(`:193`); `test/tui-run-ceiling-row.test.js` — the silence window at 0 leaves the run ceiling
standing with no line.

### 7.2 "Does this need a run?" — a pre-spawn checklist in the role prompt

In `ORCHESTRATOR_PROMPT` (workflow belongs there, not in the protocol block), after the
release rule and before the cut-unit line (`src/agents.js:54`), ~77 tokens:

```
Before each spawn, take the first that fits: a figure from numbers you hold → calc; text you already hold → give it to the documenter with the file, the place in it and the text; a fact about the tree you are about to brief → a refuter, as a numbered claim list. What none of these covers gets its own run.
```

The follow-up clause stands where `reuse` exists: the static prompt names no `reuse`
(§1.5, drift guard `test/role-briefs.test.js:105-117`), so it stands in
`ORCHESTRATION_REUSE_GUIDE` after the "Reuse it when …" line (`src/prompts.js:78`), injected
only with retention on, ~26 tokens: "A follow-up for a subagent that `list()` shows RETAINED
goes to it with `reuse`, before any new spawn." The guide is no contract element
(`CONTRACT_ELEMENTS` selects from `ORCHESTRATION_GUIDE`, `src/prompts.js:306-315`), so no
re-pin follows from it. Tests: "the orchestrator checks for a cheaper move before each spawn"
(`test/role-briefs.test.js:331`); the reuse block test in `test/retention-texts.test.js`
matches the clause.

### 7.3 The documenter writes from the material it is given

The 204k nested tokens were researcher children of the documenter, whose one nested target
the researcher then was. That edge is gone: `NESTED_SPAWN_TARGETS` has no `documenter` key
(`src/agents.js:350-357`), the documenter's map carries `...NO_SPAWN` (`:535`), so it gets
`SUBAGENT_NO_SPAWN_GUIDE` instead of the delegation block. `DOCUMENTER_PROMPT`
(`src/agents.js:159-165`) has the brief hand over the exact file, the place in it and the
content or facts to write (`:162`); a gap in it goes to the caller as one `ask`, then as a
reply opened with `Blocked:` naming what is missing (`:163`). The same holds for the gitter
(`:214`, `:215`, map `:592`). The documenter also carries no outline block, no codegraph card
(`OUTLINE_DISABLED_AGENTS`, `src/prompts.js:373`) and no TODO tools (`:537`): it reads only
the document it changes.

The other side of that decision — the lookup a documenter used to make itself has an owner
before the documenter starts: a release note or a version the docs must state is obtained by a
researcher the orchestrator spawns, and its answer goes into the documenter's brief with the
file and the place. The checklist line of §7.2 ("text you already hold → give it to the
documenter with the file, the place in it and the text") is the orchestrator's half of that.
No code carries §7.3 beyond what stands above.

### 7.4 One slot pool, and the cap

One pool, decided (user, 2026-09-29): every role counts against `maxSubagents` exactly as
`spawnCapDecision` decides (`src/registry.js:934-942`, §1.2) — no `LIGHT_ROLES`, no
`maxLightSubagents`, no second counter beside `pendingSpawns.count`, and the refusal text
(`src/tools.js:691-697`) and `slotsNoticeAfterFinish` (`src/notices.js:384`) keep their one
figure. What the decision accepts: a scout, refuter or grounder started while every slot is
held by a long run is refused like any other spawn and waits for a slot to free.

The built-in default is 1 (the safe value for a local backend at `parallel 1`, the case solo
mode exists for). The live 6 is the user's setting: with calc and reuse taking the small runs
out of the pool, and the run ceiling (§7.1) ending the long ones, the refusals should fall
without raising it. Observation that decides a later change: the count of
`spawn refused: subagent limit` lines (`src/tools.js:692`) in
`~/.cache/opencode-agent-intercom/debug.log` per orchestrator session, before and after
steps S1–S7.

## 8. Outside the plugin boundary

**vidl (project matter, for vidl's own runs) — both pending:**

- V1 — `AGENTS.md` gets a "Running the real artefact" section: how the web app with the real
  wasm is served (command, port, URL) and which console lines prove the module loaded
  (`__wbindgen_start` present), and what a correct render looks like on screen for the
  verifier's screenshot checks. The browser itself is the plugin's `pw` (§5.3). Source:
  `notes/wasm-test-oracle.md`. `/home/wu/vidl/AGENTS.md` has no such section.
- V2 — a procedure file `RELEASE.md` (or `script/release-wasm.sh` plus a short `RELEASE.md`
  calling it) made from `notes/wasm-publish-loop.md`: each step with its command and its
  check, the "no concurrent build" rule as a step with a command, the re-pin as an edit step
  naming file, key and value (the releaser holds `edit`, §6) or as a command, and each commit
  step with its files and its message (a hash or version as `<value from step k>`). Neither
  file exists in `/home/wu/vidl`.

**The user's config (`~/.config/opencode/`, not in the repo):**

- U1 — `llm-models.json`, in place: `scout` (`:38-41`) and `checker` (`:42-45`) on
  `cliproxy/qwen3.8-flash-medium`; `refuter` → `cliproxy/qwen3.8-flash-medium` (`:46-49`),
  `verifier` → `cliproxy/gpt-6-luna` (`:50-53`), `releaser` → `cliproxy/gpt-6-luna`
  (`:54-57`). Without a pin a role runs on opencode's top-level model; for the verifier the
  sidebar note and the no-vision line (§5.1) show whether that default can see.
- U2 — `agent-intercom.json`, in place: `maxRetainedSubagents: 2` (`:60`);
  `agentRunMs: { "scout": 900000, "refuter": 900000, "verifier": 1800000, "releaser": 5400000,
  "documenter": 1200000 }` (`:52-58`); `resultTokens` entries of 1500 for `scout`, `checker`,
  `refuter`, `verifier`, `releaser` like every other role there (`:35-51`); `maxSubagents` 6
  (`:2`).
- U3 — `opencode.json`, pending and only where `mimo-v2.6-pro` is to serve as a vision model:
  `"modalities": {"input": ["text", "image"]}` on `provider.cliproxy.models["mimo-v2.6-pro"]`
  (§1.8). Without it opencode strips its images.

## 9. Built state

- `AGENTS` holds 15 roles: the twelve of HEAD `1ff5bb1` plus `refuter`, `verifier` and
  `releaser`, in the order `… scout, refuter, checker, verifier, releaser`; none of the three
  has a nested target (each carries `NO_SPAWN`), none holds todo tools, none is a web role,
  and only the orchestrator spawns them. `verifier` and `releaser` are in
  `OUTLINE_DISABLED_AGENTS` and `AGENTS_MD_SUBAGENTS`/`HAS_AGENTS_MD`; the `refuter` is in
  neither and carries the outline block and the codegraph card, like the scout.
- The scout answers a lookup in its location or summary form and nothing else; the refuter
  answers a numbered claim list in its claim form and is the one role that checks claims.
- A tool `calc` exists, held by the orchestrator and every subagent; `PRIMARY_TOOLS` holds
  `spawn`, `abort`, `list`, `message`, `reuse`, `calc`.
- `GIT_STEPS` is one text in `GITTER_PROMPT` and `RELEASER_PROMPT`; no role on the gitter's
  exact-brief rule composes a commit message. The releaser holds `edit` and changes a file
  where a step says so; its reply opens with `Release: done` or, on every stop, `Blocked:`.
- The verifier holds `write` without a path limit, in code and in its prompt.
- `VISION_ROLES = ["verifier"]`; a verifier on a model without image input is told so in its
  system prompt and the sidebar shows it.
- Every subagent's shell has the plugin's `pw` on `PATH`, one daemon per session, with a
  console and page-error record; `pw start` never downloads a browser and answers a missing
  one with `pw: browser not installed — report this check as NOT RUN` and exit 1.
- The run ceiling applies whenever its own setting is non-zero.
- One slot pool, `maxSubagents`.
- `ORCHESTRATOR_PROMPT` names its five static tools (`reuse` in its own block), lists 14
  subagents with a pick line each, the premise, runtime-proof and release rules, the
  pre-spawn checklist, and the usual order with refuter, verifier and release, all in the §0.1
  standard.
- Every hand-kept role list of §1.1 is either derived or guarded by a test against
  `SPAWNABLE_ROLES`.

## 10. Steps

Every step is built in the working tree; the e2e drivers of S4–S6 are wired into
`test/e2e/run-all.sh`.

| step | built result | depends on |
|---|---|---|
| S1 | Run ceiling decoupled (§7.1): `src/watchdog.js:182-184`, `runCeilingNotice` without the silence test, comments in `src/watchdog.js`, `src/hooks.js`, `src/childwait.js`, `src/instancerestart.js`; the TUI run row without its watchdog-off note; unit tests | — |
| S2 | `calc` (§3): `src/calc.js`, registration in `src/tools.js`, `calc` in `PRIMARY_TOOLS`, protocol line, role line `src/agents.js:48`, contract fixture re-pinned; unit tests incl. the orchestrator's allowlist | — |
| S3 | Role plumbing (§1.1): the Available line equals `SPAWNABLE_ROLES`; `HAS_AGENTS_MD` equals `AGENTS_MD_SUBAGENTS` plus `orchestrator`, both exported and held by a test (deriving one from the other would close an import cycle, `src/hooks.js` imports `src/promptsfile.js`); `E2E_PINNED_AGENTS` against `AGENT_NAMES` minus `E2E_PIN_EXEMPT_AGENTS`; the literal side lists together equal `SPAWNABLE_ROLES`; the other role-list tests read `SPAWNABLE_ROLES`. Behaviour unchanged | — |
| S4 | `refuter` (§4): `REFUTER_PROMPT` and entry after `scout`, `DEFAULT_AGENT_CONTEXT` both copies, `AGENT_NAMES`, `E2E_PINNED_AGENTS`, the role comments and counts, Available line, pick, premise rule and usual-order claim step, coder premise line; `NON_DELEGATING_ROLES` in the tests; unit + `refuter-task.sh` | S2, S3 |
| S5a | `pw` reachable and isolated (§5.3): `bin/shims/pw`, `bin/pw-lib.js`, `src/shellenv.js` + `shell.env` wiring, `PW_SESSION` names, console ring and `pw console`, idle exit, no browser download in `pw start`; unit tests. Repairs the debugger's `pw` as well | — |
| S5b | `verifier` (§5): entry after `checker`, prompt, lists, `OUTLINE_DISABLED_AGENTS`, `AGENTS_MD_SUBAGENTS` + `HAS_AGENTS_MD`, `VISION_ROLES` both copies, `VERIFIER_NO_VISION_LINE` through `noVisionLineFor`, TUI note, dispatch lines, the verifier in the refuter's not-checkable line and in the release rule and usual order; `E2E_VISION_MODEL`, `E2E_AGENT_PINS` and `model-audit.py --agent-model` in the harness; unit + `verifier-task.sh` | S3, S5a |
| S6 | `releaser` (§6): `GIT_STEPS` moved out of `GITTER_PROMPT`, entry with `edit` granted, prompt with the edit-where-a-step-says line and the one reply block, lists, `OUTLINE_DISABLED_AGENTS`, `AGENTS_MD_SUBAGENTS` + `HAS_AGENTS_MD`, dispatch lines; unit + `releaser-task.sh` | S3 |
| S7 | Pre-spawn checklist (§7.2) at `src/agents.js:54` and the reuse clause at `src/prompts.js:78` | S2, S4 |

## 11. Assumptions

| assumption | must hold | shown wrong by |
|---|---|---|
| The 204k nested tokens were researcher children of the documenter fetching material already in its briefing or the repo | at the time the documenter's only nested target was `researcher`, so the children were researchers; what they fetched is not in this material | the vidl session transcript of that documenter run showing a fetch of material absent from both |
| The ~20 refusals included spawns that calc, reuse or a bounded run would have served | the orchestrator's wish names cheap checks carried in expensive runs | the before/after refusal count of §7.4 not falling |
| One slot pool leaves room for the short runs with calc, reuse and the run ceiling in | long runs end at their ceiling and follow-ups go to retained subagents | refusals in the debug log after S7 that fall mostly on scout, refuter or grounder spawns |
| The refuter on `qwen3.8-flash-medium` searches a universal claim exhaustively rather than stopping at the first hit | the prompt names codegraph `callers`/`impact` and grep over every spelling for "all"/"only" claims | the universal claim of `refuter-task.sh` answered `holds` |
| A weak orchestrator tells a question (scout) from a claim (refuter) by the pick line | the two picks name different deliverables — a location or summary, a verdict per claim | a session log with a numbered claim list sent to a scout, or a lookup sent to a refuter |
| `gpt-6-luna` fills `<value from step k>` from an earlier step's output reliably | the procedure names the step and the value | the `releaser-task.sh` `subject` criterion failing |
| opencode accepts agent entries with a `hidden: true` subagent it has never seen and resolves an unpinned one to a default model | it does so for the fourteen subagent roles | a role failing to spawn in the S4, S5b or S6 e2e |
| A `bash`-holding subagent may act on paths outside its session directory (`/home/wu/vidl-wasm`, `~/.cache/ms-playwright`) without an opencode permission prompt | the releaser (by `bash` and `edit`) and the verifier must reach them | the S5b/S6 e2e hanging on a permission request (then an `external_directory` grant goes into those roles' maps) |
| The releaser, holding `edit`, stops at a failed step instead of editing its way past it | the prompt's edit-where-a-step-says and stop lines | the `releaser-task.sh` reply `Release: done`, or the file the failing check expects made |
| The verifier, holding `write` without a limit, overwrites no tracked file | the prompt's "Leave existing files as they are" and a briefing that names what to check, not what to change | the `untouched` criterion of `verifier-task.sh` failing |
| The verifier takes a failed `pw start` as the result and reaches for no browser of its own | the two `pw` rules of its prompt and the one line `pw start` prints | the `leg4 env` or `leg4 browser` criterion of `verifier-task.sh` failing |
| A wasm build plus install finishes within 90 min | U2's `releaser` ceiling | a releaser reaped by `maxSubagentRunMs` mid-install |
| Doubles are exact enough for the arithmetic asked of `calc` | byte and token figures stay under 2^53 | a need for exact 64-bit arithmetic (then a BigInt path for integer-only expressions) |
| The installed opencode 1.18.33 carries images as the read source 1.18.32 does (§1.8) | `read` returns a `file` attachment, openai-compatible lifts it into a user message, `unsupportedParts` gates on `capabilities.input.image` | leg 2 of `verifier-task.sh` failing with the model saying it received no image, or the reply quoting "ERROR: Cannot read" on a model declared with image input |
| The cliproxy endpoint forwards image parts of a user message to `gpt-6-luna` | the provider declares image input and the proxy passes the content through | leg 2 answering from the file name or the console alone; a request log in `~/.cache/opencode-agent-intercom/` showing the image part dropped |
| A viewport screenshot costs on the order of a thousand context tokens on this provider | the verifier's 100k budget holds a dozen screenshots with room | the verifier's `ctx` figure jumping by far more per `read` of a PNG in the S5b e2e |
| `mimo-v2.6-pro` sees images upstream (the user's statement) | U3 then makes it usable | after U3, leg 2 pinned to it misjudging a plain red rectangle |
| `shell.env` is called for subagent bash calls with the subagent's `sessionID` | `opencode/src/tool/shell.ts:416-425` passes `ctx.sessionID` | the `leg1 pw` criterion of `verifier-task.sh` failing with `pw` not found |

## 12. Open

Nothing is open in the plugin. V1, V2 and U3 (§8) are pending outside it.
