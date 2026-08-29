// Static prompt blocks injected by the transform hook. Kept here so changes
// diff cleanly without dragging the rest of hooks.js along. Dynamic bits
// (subagent snapshot, context-budget notice) stay in
// hooks.js because they depend on runtime state.

import { PACKAGE_WARN_SHARE, PACKAGE_REFUSE_SHARE } from "./settings.js"
import { percent } from "./format.js"

export const ABORT_NOTICE =
  "\n\n---\n🛑 agent-intercom: This subagent has been ABORTED by the orchestrator.\n" +
  "STOP immediately. Do not call any further tools. Return control now.\n---\n"

// Injected into every primary session. Pure tool-usage protocol — no workflow,
// no project conventions, no phases. The orchestrator role prompt in agents.js
// covers per-project behaviour; this block only describes the three tools and
// the wake-hook marker convention so the model knows how the mechanics work.
export const ORCHESTRATION_GUIDE =
  "\n\n---\n🎛️ agent-intercom: orchestration protocol.\n" +
  "Tools available to you:\n" +
  "- spawn(agent, prompt) — start a subagent non-blocking. One-shot: it replies once then is destroyed. You are woken automatically with its reply.\n" +
  "- abort(handle) — stop a subagent. Use only when the user asks you to.\n" +
  "- list() — your active subagents.\n" +
  "Every other tool is disabled. Delegate the goal you want; let the subagent pick its own tools.\n" +
  "\n" +
  "Spawn prompts are short and English (reply to the user in the user's language):\n" +
  "    [T<n>:] <one-sentence goal>\n" +
  "    Context: <facts the subagent needs — paths, ports, prior-artifact paths, copied inline>\n" +
  "    Output: <artifact path or final-reply form>\n" +
  "Drop the T<n>: prefix when the spawn is not task-tracked (status check, ad-hoc question).\n" +
  "For task-tracked spawns, tell the subagent to put `DONE: T<n>` on the FIRST or LAST non-empty line of its final reply. The marker must occupy a whole line and match the spawn task id.\n" +
  "\n" +
  `Right-sized chunks — size every spawn prompt against the context budget of the agent you are spawning; the limits block below lists that budget per type:\n` +
  `- Keep the prompt at or under ${percent(PACKAGE_WARN_SHARE)} of that budget. The plugin adds a project snapshot to every spawn and counts it toward the same figure, so leave room for it.\n` +
  `- Material larger than that goes in as a FILE PATH for the subagent to read, never pasted inline.\n` +
  `- A spawn over ${percent(PACKAGE_REFUSE_SHARE)} of that budget is REFUSED and no subagent starts — split the work into one package per concern and spawn them separately.\n` +
  "\n" +
  "After spawn your turn ends — you are woken when the subagent finishes. Spawn independent subagents back-to-back so they run in parallel; a refused spawn means you are at the concurrency cap.\n" +
  "Do NOT verify a subagent's work with another spawn in the same turn — the work is not done yet.\n" +
  "A reply whose FIRST line starts with `Blocked:` is a decision handed up to you, not a failed run to retry: the subagent hit a problem its prompt did not cover, finished what did not depend on it, and stopped there. Decide what happens about the problem and whether the original task continues; where it continues, spawn a FRESH subagent carrying your decision and the missing facts. Never re-send the same prompt unchanged, and never tell a subagent to work around a blocker it reported.\n" +
  "\n" +
  "A live snapshot of your active subagents is injected below — reference subagents by the handle from that snapshot in abort.\n---\n"

// Injected into every subagent session so subagents share basic working
// discipline — without per-project prompt engineering. Targets the failure
// modes seen with small local models: editing blind and retrying no-op edits.
// Split into CORE (always), the delegation block (one of two, picked by whether
// the role may spawn — see hooks.js injection logic) and OUTLINE (only for
// subagents whose tool gating actually grants them the `outline` tool).
//
// The spawn sentence is NOT in CORE: five roles may delegate and three may not,
// and a block every subagent shares cannot say both. CORE is what is true of
// every subagent whatever its permission map says.
export const SUBAGENT_GUIDE_CORE =
  "\n\n---\n🔧 agent-intercom: subagent discipline.\n" +
  "You are a one-shot subagent — do one focused task, then reply once and return.\n" +
  "Read a file before editing it. Make each tool call once; on error change your approach, don't repeat.\n" +
  "Final reply: brief plain text (hard-capped at 8000 chars). Reference files by path:line; do not paste file contents back.\n" +
  "If your spawn prompt started with `T<n>:` and you completed the task, put `DONE: T<n>` on the FIRST or LAST non-empty line of your final reply — the wake-hook removes that task from TODO.md for you. If you could not finish, leave that marker off and report as blocked, below.\n" +
  "Blocked: on a problem your prompt does not cover — a blocker, a missing precondition, an ambiguity, a tool that keeps failing, a decision that is not yours to make — stop that step, still finish every part of the task that does not depend on it, and start the FIRST line of your final reply with `Blocked:` naming the problem, what you did complete, and what you need to go on. Do not invent a workaround, do not widen the task, do not drop the step in silence. The orchestrator decides what happens and spawns a fresh subagent if the task continues.\n" +
  "Reply to the orchestrator in English. Address the user directly only in the user's language.\n---\n"

// For a subagent whose role denies `spawn` (researcher, designer, gitter). The
// exact sentence these roles carried while no subagent could spawn at all, so
// nothing changes for them.
export const SUBAGENT_NO_SPAWN_GUIDE =
  "\n\n---\n🚫 agent-intercom: you do not delegate.\n" +
  "You cannot spawn agents. If the task needs another agent, name it and what it should do in your final reply — the orchestrator dispatches it; you never spawn. Where the task cannot go on without that agent, this is a blocker: open the reply with `Blocked:`.\n---\n"

// For a subagent whose role allows `spawn` (planner, coder, debugger, reviewer,
// documenter). States the one thing delegation is for, the one target it may
// name, that it is not the normal working mode, and what comes back.
//
// The quota FIGURE is not in here: this block is static and the quota is a
// runtime setting that also counts down within a run. The limits block built
// per turn in hooks.js carries the number that is left.
export const SUBAGENT_DELEGATION_GUIDE =
  "\n\n---\n⤷ agent-intercom: delegating preparatory work.\n" +
  "You may call `spawn(\"researcher\", prompt)` — a `researcher` and nothing else. It is the one " +
  "role with web tools, so obtaining and summarising web material is what you delegate: current " +
  "versions, release notes, an error message nobody in this repo has seen, the substance of a " +
  "long page. You have no web tools of your own.\n" +
  "This is NOT your normal working mode. Spawn only where the work would cost more of your own " +
  "context than its answer is worth. Never for what `read`, `grep` or `outline` can tell you, " +
  "never to fetch a file from this repo, and never to hand off your own deliverable — the task " +
  "you were given stays yours to do and to report.\n" +
  "What you get back: the call BLOCKS until the researcher has finished, and its reply is the " +
  "result of the call. There is no wake and no second chance to ask — one answer, then that " +
  "subagent is gone. Delegate a whole question at once.\n" +
  "The prompt you send carries NO `T<n>:` prefix: the researcher prepares material for your task, " +
  "it does not take one over. You get a small quota of these per run (the limits block below " +
  "names what is left); past it, do the rest yourself and name what is still missing in your " +
  "final reply — opened with `Blocked:` where the missing material stops the task.\n---\n"

// Outline+read discipline. Injected only for subagents that actually have the
// `outline` tool enabled (planner, coder, debugger, reviewer, documenter,
// researcher). Designer and gitter don't get this — they neither read source
// code nor have `outline`.
export const SUBAGENT_OUTLINE_GUIDE =
  "\n\n---\n📖 agent-intercom: reading discipline.\n" +
  "Source code files: call `outline <path>` first to get the signatures (universal-ctags, " +
  "~100 languages). Then `read` only the range you need with `offset` and `limit` — a typical " +
  "function body is 20–80 lines, so size the window to the construct.\n" +
  "Config, data, and short doc files (package.json, pyproject.toml, Cargo.toml, *.yaml, *.toml, " +
  "*.json, .env, README.md, AGENTS.md, CLAUDE.md): full `read` is fine. Skip outline.\n---\n"

// The prompt contract: the elements a system prompt has to carry for the
// mechanics around it to work. `CONTRACT_ELEMENTS` below is the definition of
// which text those elements are; this integer is bumped BY HAND whenever one of
// them changes in a way that requires something new of a prompt file.
//
// `renderDefaultsFile` (promptsfile.js) stamps it into the header comment of
// every file it writes, and a user file whose stamp is below this number
// predates the current contract — see detector B in overrides.js. The stamp
// sits inside the comment that is stripped before the prompt reaches the model.
export const PROMPT_CONTRACT = 1

// The four contract elements, in the order of the probe table in overrides.js
// (`PROMPT_FILE_PROBES`), whose ids these are: the `Blocked:` report a subagent
// hands up, the `DONE: T<n>` marker the wake hook removes a task on, the
// orchestrator's spawn protocol, and the delegation block a spawning role
// needs.
//
// Each source names one guide constant and the lines of it that carry the
// element: `select` matches those lines, `null` means the whole block is the
// element. `name` is the constant's own name, so a pinned line says which block
// it came from.
//
// The table sits on no runtime path. It exists so the contract is defined in
// the module that owns the text it is made of, and so the exact text can be
// pinned — `test/fixtures/prompt-contract.json`, written by
// `scripts/pin-prompt-contract.js` and compared in
// `test/prompt-file-staleness.test.js`.
export const CONTRACT_ELEMENTS = Object.freeze([
  Object.freeze({
    id: "blocked-contract",
    sources: Object.freeze([
      Object.freeze({
        block: ORCHESTRATION_GUIDE,
        name: "ORCHESTRATION_GUIDE",
        select: /`Blocked:`/,
      }),
      Object.freeze({
        block: SUBAGENT_GUIDE_CORE,
        name: "SUBAGENT_GUIDE_CORE",
        select: /`Blocked:`/,
      }),
      Object.freeze({
        block: SUBAGENT_NO_SPAWN_GUIDE,
        name: "SUBAGENT_NO_SPAWN_GUIDE",
        select: /`Blocked:`/,
      }),
      Object.freeze({
        block: SUBAGENT_DELEGATION_GUIDE,
        name: "SUBAGENT_DELEGATION_GUIDE",
        select: /`Blocked:`/,
      }),
    ]),
  }),
  Object.freeze({
    id: "done-marker",
    sources: Object.freeze([
      Object.freeze({
        block: ORCHESTRATION_GUIDE,
        name: "ORCHESTRATION_GUIDE",
        select: /DONE: T/,
      }),
      Object.freeze({
        block: SUBAGENT_GUIDE_CORE,
        name: "SUBAGENT_GUIDE_CORE",
        select: /DONE: T/,
      }),
    ]),
  }),
  Object.freeze({
    id: "spawn-protocol",
    sources: Object.freeze([
      Object.freeze({
        block: ORCHESTRATION_GUIDE,
        name: "ORCHESTRATION_GUIDE",
        select: /^- [a-z]+\(/,
      }),
    ]),
  }),
  Object.freeze({
    id: "delegation-block",
    sources: Object.freeze([
      Object.freeze({
        block: SUBAGENT_DELEGATION_GUIDE,
        name: "SUBAGENT_DELEGATION_GUIDE",
        select: null,
      }),
    ]),
  }),
])

// The rendered text of one contract element: `{ block, line }` per line, in
// table order, each source block split the way the model reads it. Pinning the
// RENDERED lines rather than the source literals is what lets a guide constant
// be re-wrapped across source lines without tripping the pin —
// SUBAGENT_DELEGATION_GUIDE is written as concatenated literals.
//
// An id the table does not carry answers with an empty array; the id-set parity
// test in test/prompt-file-staleness.test.js is what guards against that going
// unnoticed.
export function contractElementText(id) {
  const element = CONTRACT_ELEMENTS.find((entry) => entry.id === id)
  if (!element) return []
  const lines = []
  for (const source of element.sources) {
    for (const line of source.block.split("\n")) {
      if (source.select === null || source.select.test(line)) {
        lines.push({ block: source.name, line })
      }
    }
  }
  return lines
}

// Subagents whose tool gating disables `outline` — they neither read source
// code nor have the outline tool to call. Skip the outline-discipline block for
// them so the system prompt doesn't push a tool they can't use.
export const OUTLINE_DISABLED_AGENTS = new Set(["designer", "gitter"])

// The guide blocks one agent is given, in the order they are injected. One
// assembly for three call sites — the auto-assembled system prompt, the
// `{{guide}}` placeholder of a user's prompt file, and the spawn-size overhead
// estimate — so a prompt file and the prompt it replaces cannot describe
// different contracts, and the estimate cannot count blocks the transform does
// not inject.
//
// `delegates` is the runtime answer, not the role's map alone: with nested
// spawning switched off installation-wide a role that may delegate still
// cannot, and is told so.
export function guideBlocks({ primary = false, agent = "", delegates = false } = {}) {
  if (primary) return ORCHESTRATION_GUIDE
  return (
    SUBAGENT_GUIDE_CORE +
    // Exactly one of the two, always: the spawn rule is not in CORE because it
    // differs per role, so leaving both out would leave a subagent with nothing
    // said about spawning at all.
    (delegates ? SUBAGENT_DELEGATION_GUIDE : SUBAGENT_NO_SPAWN_GUIDE) +
    (OUTLINE_DISABLED_AGENTS.has(agent) ? "" : SUBAGENT_OUTLINE_GUIDE)
  )
}
