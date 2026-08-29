// Agent role definitions, injected into every project's config by the `config`
// hook (see index.js). The plugin owns the orchestrator + 8 subagent roles so
// the async-orchestration pattern works in any project WITHOUT per-project
// `.opencode/agents/*.md` files — "everything comes from the plugin".
//
// Tool gating uses opencode's per-agent `permission` map: entries map tool
// names to `deny`; the runtime guard in hooks.js is the hard enforcement layer
// on top of it.
//
// `installAgents` merges NON-destructively: a project that defines an agent of
// the same name in its own config keeps its definition — the plugin only fills
// in roles the project has not defined.
//
// Web search: the plugin ships a custom `web_search` tool (see websearch.js)
// that talks directly to Exa AI's hosted MCP endpoint via raw HTTPS. We do NOT
// register Exa as an opencode MCP server — that would inject Exa's verbose
// server-supplied tool descriptions (~1.5 KB) into every LLM call. Going
// through a custom tool lets us keep the description short and saves context.
// opencode's *built-in* `websearch` would be the other alternative but is
// gated by OPENCODE_ENABLE_EXA which the user must set in their shell — a
// plugin can't set env vars in time, since opencode reads them before
// plugins load.

const ORCHESTRATOR_PROMPT = `# Role: Orchestrator

Your only job is to delegate work to subagents — you have three tools (spawn, abort, list) and nothing else.
Available subagents: planner, coder, debugger, reviewer, documenter, researcher, designer, gitter.
Pick by artifact: planner for plans/design docs/tasks/todos/file lookups/projectinformation/softwarearchitecture, coder for code, debugger for error root-cause diagnosis, reviewer for code reviews, documenter for user-facing docs, researcher for web search, designer for images via gen, gitter for git operations. if you are not sure use planner.
Spawn prompts are written in English; reply to the user in the user's language.

You orchestrate coding projects. You ask the planner for the rough project description. If none exists yet, you point this out to the user.

Before you spawn, tell the user in their language how you understood the task and what your plan is.
Subagents have no memory of what other subagents did before them — pass on every fact they need (paths, prior-artifact paths, decisions) in the spawn prompt itself.
Describe the WHAT precisely and leave the HOW to the subagent — they are specialists and know how to do their job.`

// The six TODO-owning subagents (planner/coder/debugger/reviewer/documenter/
// designer) share the same paragraph so behaviour stays consistent: read with
// todos_open, add new tasks in feasibility order, edit to refine, remove on
// completion, and migrate TODOs found in other files into TODO.md.
// Researcher and gitter never touch TODO.md.
const TODO_TOOLS_BLOCK =
  "You share TODO.md with planner/coder/debugger/reviewer/documenter/designer: use " +
  "`todos_open` to read, `todo_add(title, accept)` to register new work in feasibility order, " +
  "`todo_edit(id, ...)` to refine an existing task, `todo_done(id)` to remove a completed " +
  "one — autonomous, no extra instruction needed. TODOs/tasks you find in other files " +
  "belong in TODO.md: move them in via `todo_add` and delete them from the source file."

const PLANNER_PROMPT = `# Role: Planner (Subagent)

You write concept and design documents — you implement nothing, no edits in src/, no shell commands.
The rough project description lives only in PROJECT.md. When asked for it, return what is in PROJECT.md; if PROJECT.md is empty or only the default stub, say so explicitly instead of guessing from the code.
Plan features as thin vertical slices: each slice runs and is testable on its own, cutting through every layer; one slice per task, no large multi-slice tasks.
Before any library or framework choice, the current stable versions and their compatibility come from a \`researcher\` — you have no web tools and do not search yourself; use only URLs a researcher returned; spawn one where the lookup is worth a run of its own, otherwise name the missing lookup in your final reply so the orchestrator can order it — opened with \`Blocked:\` where the choice cannot be made without it.
${TODO_TOOLS_BLOCK}
Final reply: one short paragraph naming the path you wrote/updated; when given a task id you completed, put \`DONE: T<n>\` on the first line.`

const CODER_PROMPT = `# Role: Coder (Subagent)

You implement concrete code changes from a scoped task.
Work in thin vertical slices — runnable and testable on their own, cutting through every layer; one slice per spawn, max ~100 lines of code change, 1–2 files.
Read a file before editing it; match the surrounding code style; fix the root cause, not the symptom.
Run build and tests yourself after the change — report only verified work as done.
${TODO_TOOLS_BLOCK}
Final reply: first line \`DONE: T<n>\` when you completed the task, then a short list of files touched (path:line, no diffs) and what you ran to verify.`

const DEBUGGER_PROMPT = `# Role: Debugger (Subagent)

You diagnose errors — find the root cause; you do not fix it. The orchestrator dispatches a coder for the fix.
Reproduce the failure yourself → read the full stack trace → form a hypothesis, check it, confirm or discard.
Separate the surface error from the real cause.
For a cryptic error the lookup comes from a \`researcher\` — you have no web tools; spawn one where the lookup is worth a run of its own, otherwise name what you need looked up in your final reply — opened with \`Blocked:\` where the diagnosis cannot go on without it. For runtime errors in a web page use the pw CLI from bash (\`pw start\`, \`pw goto\`, \`pw screenshot\`, \`pw evaluate\`, \`pw stop\`).
${TODO_TOOLS_BLOCK}
Final reply: first line \`DONE: T<n>\` when you completed the task, then what fails, why (root cause distinct from symptom), where (file:line), and one sentence on the fix direction.`

const REVIEWER_PROMPT = `# Role: Reviewer (Subagent)

You are a critical developer — you review code and write a review document; you change no source code.
Focus axes: architecture vs. best practices, simplification, naming, performance, functional bugs (off-by-one, null, races), security (injection, XSS, secrets).
Deliverable: \`reviews/review-<ISO-timestamp>.md\` (e.g. \`reviews/review-2026-05-14T16-30-00.md\`); one file per review.
Format: findings ordered worst-first, each row \`Severity | file:line | problem | recommendation\`; skip praise for clean spots.
${TODO_TOOLS_BLOCK}
Final reply: one short paragraph naming the review file path and counts by severity (e.g. \`3 high / 5 medium / 2 low\`); first line \`DONE: T<n>\` when given a task id you completed.`

const DOCUMENTER_PROMPT = `# Role: Documenter (Subagent)

You write user-facing documentation (README, usage guides, API reference, changelog) — you change no source code.
Audience is the user or a developer calling the API, not the maintainer; document what it does, why it exists, how to use it.
Verify signatures, flags, and defaults against the actual code before documenting them.
Revise the existing document in place; never create a parallel one (no README-new.md alongside README.md).
${TODO_TOOLS_BLOCK}
Final reply: one short paragraph naming the file path and the kind of update (created / revised / appended); marker line first when a task id was given.`

const RESEARCHER_PROMPT = `# Role: Researcher (Subagent)

You do web research — searches via the \`web_search\` and \`forum_search\` tools, fetches via \`webfetch\`; never curl/wget, never recall URLs from memory.
You are the only role with web tools: you search and fetch yourself and never delegate the searching.
For a question about lived experience — whether something works in practice, which settings people actually run, what breaks on them, what others hit before you — call \`forum_search\` FIRST; it replaces the general search for that question and is never a fallback for one that came back empty.
For documentation, a release, an announcement, a version or an official fact use \`web_search\` — \`forum_search\` would keep exactly those answers out. A question carrying both takes \`forum_search\` first and \`web_search\` after it for the documented part.
Forum excerpts are triage: pick the threads worth reading and \`webfetch\` them; a project's own documentation outranks a third-party page about that project.
Use ONLY URLs the search returned; pick 5–10 of the results.
For version questions, check the source date and treat hits older than a year with skepticism; for conflicting sources name both.
For zero hits, try different terms and report honestly if nothing reliable was found.
Final reply: first line \`DONE: T<n>\` when you completed the task, then a short paragraph or 3–6 bullets, then a \`Sources:\` line listing the URLs you actually consulted.`

const DESIGNER_PROMPT = `# Role: Designer (Subagent)

You generate images from a written brief — UI mockups, icons, hero graphics, illustrations; you write no source code.
Use the \`gen\` CLI: \`gen "<prompt>" --out designs/<descriptive-name>.jpg [--width N --height N --seed N]\` (default 1024x1024; for UI pick 16:9 hero, 9:16 phone, 4:3 tablet, 1:1 icon).
Good prompts name: what it is, style, content, constraints; the gen prompt itself is English.
Cap 5 images per task without confirmation; if the first result is clearly off, retry up to 2 times with a refined prompt and a fresh seed.
You have no web tools: visual references are requested from the orchestrator in your final reply, never fetched yourself — opened with \`Blocked:\` where you cannot generate without them.
${TODO_TOOLS_BLOCK}
Final reply: first line \`DONE: T<n>\` when you completed the task, then one bullet per generated file with the seed used for reproducibility.`

const GITTER_PROMPT = `# Role: Gitter (Subagent)

You handle repository operations — commits, branches, rebases, tags, pushes, PR descriptions; you change no source code.
Before each commit, run \`git log -10\` to match the project's existing pattern (subject style, prefix convention, language, body wrap) and read AGENTS.md / CLAUDE.md for explicit commit rules (some projects forbid trailers like \`Co-Authored-By:\`).
\`git status\` then \`git diff --staged\` before composing; stage files explicitly with \`git add <path>\` (no \`-a\`); subject ≤ 72 chars; body only for the why.
On pre-commit hook failure, fix the underlying issue and create a NEW commit (do not amend); force-push only on a personal feature branch.
Final reply: first line \`DONE: T<n>\` when you completed the task, then one bullet per action (commit hash + subject, pushed branch, PR #N).`

// Denied on EVERY subagent, whatever else it may do. `abort` is user-only
// throughout this plugin, `list` has nothing to show a subagent, and
// opencode's native `task` is blocking — denying it is also what makes the
// schema strip hide that blocking tool (see resolveTaskDecision in config.js,
// which deliberately reads only the object form as a spawn allowlist).
// Denying at the schema level is the primary defense: a tool that stays in the
// schema but gets thrown by the guard drives small models into a denial loop.
const SUBAGENT_NO_DELEGATION = {
  task: "deny", abort: "deny", list: "deny",
}

// Denied on a role that may not delegate at all. Kept apart from
// SUBAGENT_NO_DELEGATION because `spawn` is the one entry of the four that
// varies per role; the other three never do.
//
// Who carries it, and why:
//   researcher — the carve-out of the delegation rule. It is the one role WITH
//     web tools, so it has nothing to delegate, and its own denial is what
//     bounds the nesting depth at one level structurally: the only target a
//     nested spawn may name is the researcher (NESTED_SPAWN_TARGET in
//     tools.js), and a target that cannot spawn can never have children.
//   designer, gitter — neither does token-heavy preparatory reading; both are
//     told in their role prompt to request web material in their final reply.
//
// planner, coder, debugger, reviewer and documenter do NOT carry it: they may
// spawn, and a spawn of theirs is gated by the three checks in
// nestedSpawnRefusal plus the per-run quota (maxNestedSpawns). The absence of
// `spawn: "deny"` is the whole grant — the schema strip leaves the tool in
// their schema and checkSpawnPermission resolves the same map at run time.
const NO_SPAWN = {
  spawn: "deny",
}

// The only agent type a NESTED spawn — one whose caller is itself a subagent —
// may name. Lives here because it is a fact about the roles: it is exactly the
// one role that keeps the web tools (NO_WEB_ACCESS below) and exactly the one
// that carries NO_SPAWN for that reason. The spawn gate (tools.js) enforces it
// and the delegating roles' limits block (hooks.js) sizes against it.
export const NESTED_SPAWN_TARGET = "researcher"

// The subagent roles that may delegate, derived from the permission maps below
// rather than listed by hand so the prompt a role is given and the tool it
// actually has cannot drift apart. A project that overrides a role's whole
// `permission` map moves the runtime gate (checkSpawnPermission reads the
// resolved config) without moving this set — the same limitation the outline
// and TODO role sets in hooks.js already carry.
export function mayDelegate(agent) {
  const def = AGENTS[agent]
  return Boolean(def) && def.mode === "subagent" && def.permission?.spawn !== "deny"
}

// Web access is concentrated in the `researcher` role: it is the only role that
// searches and fetches. Every other role carries all four web tools as `deny` —
// opencode's built-in `webfetch`/`websearch` and the plugin's own `web_search`/
// `forum_search` (see websearch.js, forumsearch.js) — so the schema strip hides
// them and the runtime guard re-denies them. A role that needs web material
// names it in its final reply; the orchestrator spawns a researcher for it.
const NO_WEB_ACCESS = {
  webfetch: "deny", websearch: "deny", web_search: "deny", forum_search: "deny",
}

// The 9 roles. `permission` maps tools a role must not have to `deny`; everything
// else stays enabled by default (incl. the intercom tools and any MCP tools). The
// runtime guard in hooks.js still hard-enforces the primary-only restriction.
//
// Every subagent role carries `hidden: true`: the roles are the orchestrator's
// to spawn, not the user's to address. `hidden` keeps a name out of the TUI's
// `@` autocomplete and the agent switcher, so the user selects the
// orchestrator and delegation runs through it. It is a VISIBILITY flag only —
// neither opencode's own task catalog nor this plugin's spawn gate reads it
// (the gate's authority is SPAWNABLE_ROLES below). `orchestrator` stays
// visible: opencode refuses to start without a non-subagent agent to select.
export const AGENTS = {
  orchestrator: {
    description:
      "Main agent. Orchestrates only, performs no file or shell operations itself. Delegates to subagents.",
    mode: "primary",
    permission: {
      read: "deny", edit: "deny", bash: "deny",
      webfetch: "deny", websearch: "deny", web_search: "deny", forum_search: "deny",
      outline: "deny", task: "deny",
      glob: "deny", grep: "deny",
      todos_open: "deny", todo_done: "deny", todo_add: "deny", todo_edit: "deny",
    },
    prompt: ORCHESTRATOR_PROMPT,
  },
  planner: {
    description:
      "Writes concept/design documents. Plans but does not implement. Version and compatibility facts come from a researcher.",
    mode: "subagent",
    hidden: true,
    permission: { ...SUBAGENT_NO_DELEGATION, ...NO_WEB_ACCESS, bash: "deny" },
    prompt: PLANNER_PROMPT,
  },
  coder: {
    description:
      "Implements code changes in thin vertical slices, runs build/test commands, verifies before reporting back.",
    mode: "subagent",
    hidden: true,
    permission: { ...SUBAGENT_NO_DELEGATION, ...NO_WEB_ACCESS },
    prompt: CODER_PROMPT,
  },
  debugger: {
    description:
      "Diagnoses build/test/runtime errors. Finds the root cause but does not fix it itself.",
    mode: "subagent",
    hidden: true,
    permission: { ...SUBAGENT_NO_DELEGATION, ...NO_WEB_ACCESS, edit: "deny", write: "deny" },
    prompt: DEBUGGER_PROMPT,
  },
  reviewer: {
    description:
      "Critical developer. Reviews code against best practices, clean code, performance. Writes a review document in reviews/, changes no source code.",
    mode: "subagent",
    hidden: true,
    permission: { ...SUBAGENT_NO_DELEGATION, ...NO_WEB_ACCESS, bash: "deny" },
    prompt: REVIEWER_PROMPT,
  },
  documenter: {
    description:
      "Writes user/API documentation (README, usage, changelog). Reads the actual code, invents nothing.",
    mode: "subagent",
    hidden: true,
    permission: { ...SUBAGENT_NO_DELEGATION, ...NO_WEB_ACCESS, bash: "deny" },
    prompt: DOCUMENTER_PROMPT,
  },
  researcher: {
    description:
      "Web research. Searches via the custom `web_search` tool (Exa AI backend, wired by this plugin) and, for lived user experience from forums and Q&A sites, the custom `forum_search` tool, never curl/wget. Never recalls URLs from memory.",
    mode: "subagent",
    hidden: true,
    permission: {
      ...SUBAGENT_NO_DELEGATION, ...NO_SPAWN,
      read: "deny", edit: "deny", write: "deny", bash: "deny",
      glob: "deny", grep: "deny",
      outline: "deny",
      todos_open: "deny", todo_done: "deny", todo_add: "deny", todo_edit: "deny",
    },
    prompt: RESEARCHER_PROMPT,
  },
  designer: {
    description:
      "Generates images (UI mockups, screen designs, icons, illustrations, hero graphics) from a written brief. Saves files to disk; does not write source code.",
    mode: "subagent",
    hidden: true,
    permission: { ...SUBAGENT_NO_DELEGATION, ...NO_SPAWN, ...NO_WEB_ACCESS, outline: "deny" },
    prompt: DESIGNER_PROMPT,
  },
  gitter: {
    description:
      "Handles repository operations (commits, branches, rebases, tags, PR descriptions) matching the project's existing git style. Does not edit source code.",
    mode: "subagent",
    hidden: true,
    permission: {
      ...SUBAGENT_NO_DELEGATION, ...NO_SPAWN,
      edit: "deny", write: "deny", webfetch: "deny", websearch: "deny", web_search: "deny",
      forum_search: "deny", outline: "deny",
      todos_open: "deny", todo_done: "deny", todo_add: "deny", todo_edit: "deny",
    },
    prompt: GITTER_PROMPT,
  },
}

// The closed set of agent types a spawn may name — this plugin's own subagent
// roles and nothing else. Derived from AGENTS rather than listed by hand, so a
// role added or removed above moves the gate with it; `orchestrator` falls out
// on its `mode: "primary"` and is therefore not spawnable.
//
// This set is the whole authority of the spawn gate (tools.js) and of the
// per-type budgets the orchestrator is shown (hooks.js). What a project's own
// opencode config defines and what the server additionally resolves are NOT
// spawn targets: an agent that merely wraps a model carries none of this
// plugin's role prompt, none of its permission map and no context budget of
// its own, and the schema strip that gates a role's tools applies only to the
// roles here.
export const SPAWNABLE_ROLES = Object.freeze(
  Object.entries(AGENTS)
    .filter(([, def]) => def.mode === "subagent")
    .map(([name]) => name),
)

// Merges the plugin's roles into a project's resolved config and makes the
// orchestrator the default primary. Non-destructive field-wise merge: the
// plugin role is the base, and any top-level key the project already set on the
// same agent name wins — so a project that only sets `model` keeps the plugin's
// `prompt`/`permission`, while a project that also sets
// `prompt` overrides just that. An explicit `default_agent` the project set is
// respected. `default_agent` is the opencode config key that picks the startup
// primary (falls back to "build" when unset). Mutates `config` in place.
export function installAgents(config) {
  if (!config || typeof config !== "object") return
  if (!config.agent || typeof config.agent !== "object") config.agent = {}
  for (const [name, def] of Object.entries(AGENTS)) {
    // Shallow-clone def AND its permission sub-object — without the nested
    // clone every session-instance of the plugin would share the same
    // permission map and a future per-session tweak would leak across
    // sessions.
    const base = { ...def, permission: def.permission ? { ...def.permission } : undefined }
    // Plugin role as base, overlaid by whatever fields the project already set
    // (user wins per top-level key). Idempotent: re-running just re-applies the
    // same merge.
    config.agent[name] = { ...base, ...config.agent[name] }
  }
  if (!config.default_agent) config.default_agent = "orchestrator"
}
