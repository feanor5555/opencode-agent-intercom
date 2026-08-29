// The override finding register.
//
// One process-wide list of findings about project files that displace what this
// plugin installs, plus the renderers over it. Two producers write into it:
//
//   - the config-hook detector, for a project agent entry
//     (`.opencode/agent/<name>.md` or an `opencode.json` entry) that replaces
//     the fields the plugin sets on one of its own roles — `agent-entry`;
//   - the prompt-file scan, for a `.opencode/agent-intercom/<agent>.md`
//     template that predates a change to the prompt contract — `prompt-file`.
//
// Three consumers read it: the debug log at detection, a toast fired once per
// project, and a block in the primary's stable system prompt telling the
// orchestrator to report the finding to the user. The register itself never
// refuses anything and never touches a user's file — it only records what was
// found so those three can say it.
//
// Process-scoped, like every other map in state.js: findings from a subagent's
// directory scan are reported through the primary's block, because both live in
// the same opencode process. Every finding carries the project directory it came
// from, so sessions for different projects never receive one another's reports.
//
// Pure: no fs, no client, no log. Locating the offending file and reading it is
// the detector's job — `agents.js` for the agent entry, `promptsfile.js` for the
// prompt-file scan — and arrives here as ready-made `file` and text values. What
// this module owns of detector B is the part that has to sit next to the finding
// model: the contract-probe table, the stamp reading, and the record of which
// directories have already been scanned.

import { PROMPT_CONTRACT } from "./prompts.js"

// key (`<kind>\0<directory>\0<agent>`) -> normalized finding. A Map, so a
// re-detection of the same collision in one project cannot add a second line,
// while the same role in another project remains an independent finding.
const findings = new Map()

// The project scopes overrideToastText() has already handed its one-shot body
// out for. A Set and not a flag, keyed exactly as the findings are: one process
// serving two projects owes each of them its own toast, and a single latch
// would spend the first project's toast on behalf of the second, whose user
// would then never be told at all.
const toastedScopes = new Set()

const KIND_AGENT_ENTRY = "agent-entry"
const KIND_PROMPT_FILE = "prompt-file"

// The order findings are rendered in: by kind, then by agent name. Deliberately
// NOT insertion order — the block goes into the primary's STABLE system prompt
// element, whose text must not move between the turns of a session, and the
// order two detectors happen to fire in is not a property of the findings.
const KIND_ORDER = [KIND_AGENT_ENTRY, KIND_PROMPT_FILE]

const nonEmptyString = (v) => typeof v === "string" && v.length > 0

// A finding renders into one line of a system-prompt block, so every string it
// carries must be one line.
function oneLine(v) {
  return nonEmptyString(v) ? v.replace(/\s+/g, " ").trim() : ""
}

// Keeps the caller's order (the detector iterates a fixed field list, which is
// the order worth showing) and drops duplicates and anything that is not a
// non-empty string.
function stringList(v) {
  if (!Array.isArray(v)) return []
  const out = []
  for (const item of v) {
    const s = oneLine(item)
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

function scopeOf(directory) {
  return nonEmptyString(directory) ? directory : null
}

function keyOf(kind, directory, agent) {
  return `${kind}\u0000${directory ?? ""}\u0000${agent}`
}

// Writes a normalized finding under its `kind + directory + agent` key.
//
// Returns true when the register CHANGED — the finding is new, or it differs
// from the one already stored under that key (a rescan after the user edited
// the file). Returns false for an exact repeat and for a finding with no usable
// agent name, so a caller can log and toast on a change without having to
// remember what it already saw.
function record(kind, input) {
  const agent = oneLine(input?.agent)
  if (!agent) return false
  const directory = scopeOf(input?.directory)
  const finding = Object.freeze({
    kind,
    agent,
    directory,
    fields: Object.freeze(kind === KIND_AGENT_ENTRY ? stringList(input?.fields) : []),
    missing: Object.freeze(kind === KIND_PROMPT_FILE ? stringList(input?.missing) : []),
    file: nonEmptyString(input?.file) ? input.file : null,
    detail: oneLine(input?.detail),
  })
  const key = keyOf(kind, directory, agent)
  const before = findings.get(key)
  if (before && sameFinding(before, finding)) return false
  findings.set(key, finding)
  return true
}

function sameFinding(a, b) {
  return (
    a.file === b.file &&
    a.detail === b.detail &&
    a.fields.length === b.fields.length &&
    a.fields.every((f, i) => f === b.fields[i]) &&
    a.missing.length === b.missing.length &&
    a.missing.every((m, i) => m === b.missing[i])
  )
}

// A project agent entry displaced the plugin's role. `directory` identifies the
// project session that owns the finding, `fields` names the fields of the
// plugin's role the project entry carries its own value for, `file` the markdown
// file it was found in or null when the entry has no file (an `opencode.json`
// entry), and `detail` is an optional one-line replacement for the generated
// wording.
export function recordAgentEntryOverride(finding) {
  return record(KIND_AGENT_ENTRY, finding)
}

// A `.opencode/agent-intercom/<agent>.md` template is missing contract elements
// the current prompt would inject. `directory` identifies the project session
// that owns the finding, and `missing` names the probe ids that did not match.
export function recordPromptFileOverride(finding) {
  return record(KIND_PROMPT_FILE, finding)
}

// Whether anything has been found in this process, or in one project when a
// directory is supplied.
//
// A test seam like resetOverrides, not a plugin path: the delivery side asks
// `overrideBlock(scope) !== ""`, because it needs the text anyway and a
// separate emptiness question would be a second answer to the same thing.
export function hasFindings(directory) {
  return (arguments.length ? overrideFindings(directory) : overrideFindings()).length > 0
}

// Every finding, in render order. When a directory is supplied, only findings
// from that project are returned. Frozen records in a fresh array: the log
// outlet reads them per finding, and no consumer can reshape the register by
// holding on to what it got. With no argument, all findings are returned for
// process-level inspection and test seams.
export function overrideFindings(directory) {
  const scoped = arguments.length > 0
  const scope = scopeOf(directory)
  return [...findings.values()]
    .filter((finding) => !scoped || finding.directory === scope)
    .sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.agent.localeCompare(b.agent) ||
        (a.directory ?? "").localeCompare(b.directory ?? ""),
    )
}

function describe(finding) {
  if (finding.detail) return finding.detail
  if (finding.kind === KIND_AGENT_ENTRY) {
    return finding.fields.length
      ? `a project agent entry replaces ${finding.fields.join(", ")}`
      : "a project agent entry replaces this plugin's role"
  }
  return finding.missing.length
    ? `the prompt file predates the current prompt contract, missing: ${finding.missing.join(", ")}`
    : "the prompt file predates the current prompt contract"
}

function fileOf(finding) {
  return finding.file ? finding.file : "no file — the entry comes from the opencode config"
}

// The block for the primary's stable system prompt: every finding in the
// session's project, by name, and the instruction to pass it on. Empty string
// when there is nothing to report, so the caller can append it unconditionally.
// With no directory argument, all findings are rendered for process-level tests.
//
// Its text depends on the selected findings alone, so it holds its bytes for as
// long as that set does — which is what lets it live in the cached stable
// element instead of costing a breakpoint every turn.
export function overrideBlock(directory) {
  const selected = arguments.length ? overrideFindings(directory) : overrideFindings()
  if (selected.length === 0) return ""
  const lines = selected.map(
    (f) => `- ${f.agent}: ${describe(f)} (${fileOf(f)})`,
  )
  return (
    "\n\n---\n⚠️ agent-intercom: project files are overriding this plugin's roles.\n" +
    lines.join("\n") +
    "\n" +
    "Tell the user about this in your next answer, once: name each role and file above and what it " +
    "displaced. Then carry on with the work — this is a report, not a blocker, and nothing here is " +
    "yours to change: do not edit or delete these files, and do not spawn a subagent to do it.\n---\n"
  )
}

// The one-shot toast body, or null when there is nothing to report in the
// selected project or that project's toast has already been handed out.
// The title and the variant belong to the call site; this is the message alone.
// With no directory argument, all findings are counted for process-level tests.
export function overrideToastText(directory) {
  const all = arguments.length ? overrideFindings(directory) : overrideFindings()
  const scope = scopeOf(directory) ?? ""
  if (all.length === 0 || toastedScopes.has(scope)) return null
  const overridden = all.filter((f) => f.kind === KIND_AGENT_ENTRY).length
  const stale = all.length - overridden
  const parts = []
  if (overridden) parts.push(`${overridden} role${overridden === 1 ? "" : "s"} overridden by project files`)
  if (stale) parts.push(`${stale} prompt file${stale === 1 ? "" : "s"} out of date`)
  toastedScopes.add(scope)
  return `${parts.join(", ")} — see the orchestrator's first answer`
}

// ----------------------------------------------------------------------------
// Detector B — a customised prompt file that predates the current contract.
//
// Two mechanisms, because one alone does not cover the population. The files on
// disk today were written before any stamp existed, so the CONTRACT PROBES are
// what covers them: each probe is one element the auto-assembled prompt would
// inject for that role, and a file that does not carry it is running the old
// contract. The CONTRACT STAMP covers every file written from now on: it is
// exact where a probe is only indicative, and it keeps working for a file whose
// guide sits behind the `{{guide}}` placeholder instead of being inlined.
//
// The reading of the two: a file that HAS a stamp is judged by the stamp alone
// (its author saw the contract the stamp names), a file with NO stamp falls back
// to the probes.
//
// The fs is not here — `scanPromptFiles` in promptsfile.js reads the files and
// hands the split text in.

// The `{{guide}}` placeholder substitutes to the guide blocks of the role at
// call time (prompts.js `guideBlocks`), so a file carrying it cannot go stale on
// any probe: every probe below tests text that placeholder injects. Matched
// case-insensitively, like `substitutePrompt`.
const GUIDE_PLACEHOLDER = /\{\{guide\}\}/i

// The stamp `renderDefaultsFile` writes into the header comment.
export const CONTRACT_STAMP_KEY = "agent-intercom-contract"
const CONTRACT_STAMP = /agent-intercom-contract:\s*(\d+)/

// The roles the `DONE: T<n>` marker does something for: the six that own
// TODO.md (hooks.js TODO_AGENTS) plus the orchestrator, which writes the marker
// contract into the spawn prompt. Pinned against those sources by
// test/prompt-file-staleness.test.js — this module cannot import either one
// (agents.js imports this file, and hooks.js does too).
const DONE_MARKER_AGENTS = [
  "orchestrator",
  "planner",
  "coder",
  "debugger",
  "reviewer",
  "documenter",
  "designer",
]

// The roles whose permission map allows `spawn` (agents.js mayDelegate), i.e.
// the ones the auto path gives SUBAGENT_DELEGATION_GUIDE to. Same pinning.
const DELEGATING_AGENTS = ["planner", "coder", "debugger", "reviewer", "documenter"]

// One probe per contract element: `agents: null` means every role, `re` is what
// the file must carry, `why` is what breaks without it. Each probe is asserted
// against the current constants by the parity test, so an edit to prompts.js
// that drops an element fails a test instead of silently making every file on
// disk look fresh.
export const PROMPT_FILE_PROBES = Object.freeze([
  Object.freeze({
    id: "blocked-contract",
    agents: null,
    re: /`Blocked:`/,
    why: "the subagent hands a decision up instead of improvising",
  }),
  Object.freeze({
    id: "done-marker",
    agents: Object.freeze(DONE_MARKER_AGENTS),
    re: /DONE: T/,
    why: "the wake hook removes a task from TODO.md on this marker",
  }),
  Object.freeze({
    id: "spawn-protocol",
    agents: Object.freeze(["orchestrator"]),
    re: /spawn\(/,
    why: "the three tools the primary has",
  }),
  Object.freeze({
    id: "delegation-block",
    agents: Object.freeze(DELEGATING_AGENTS),
    re: /spawn\("researcher"/,
    why: "a role that may delegate is otherwise never told the target it may name",
  }),
])

function probeApplies(probe, agent) {
  return probe.agents === null || probe.agents.includes(agent)
}

// The contract number a prompt file's header comment stamps, or null when it
// carries none — which is every file written before the stamp existed.
export function readContractStamp(header) {
  const m = CONTRACT_STAMP.exec(String(header ?? ""))
  if (!m) return null
  const n = Number.parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

// Judges one prompt file. `header` is the leading HTML comment (where the stamp
// lives and where nothing else is looked for), `body` the text that actually
// reaches the model.
//
// Returns `{ missing, detail }`: the probe ids the file does not satisfy, and
// for the stamp case the one line that says it instead. Both empty when the file
// is current.
export function classifyPromptFile(agent, { header = "", body = "" } = {}) {
  const stamp = readContractStamp(header)
  if (stamp !== null) {
    return stamp < PROMPT_CONTRACT
      ? {
          missing: ["contract-stamp"],
          detail:
            `the prompt file was rendered against prompt contract ${stamp}, ` +
            `the current contract is ${PROMPT_CONTRACT}`,
        }
      : { missing: [], detail: "" }
  }
  if (GUIDE_PLACEHOLDER.test(body)) return { missing: [], detail: "" }
  const missing = PROMPT_FILE_PROBES.filter(
    (probe) => probeApplies(probe, agent) && !probe.re.test(body),
  ).map((probe) => probe.id)
  return { missing, detail: "" }
}

// Directories whose prompt files have already been scanned in this process.
const scannedDirectories = new Set()

// Claims the one scan of a directory: true for the caller that gets to run it,
// false for every later one.
//
// The scan is eager and once — nine stats at the first primary transform of a
// directory — for two reasons. Per-request probing would put fs work on the hot
// path of every LLM call, and the finding set has to be COMPLETE before the
// first block is rendered: the block lives in the stable system-prompt element
// and its text must not move between the turns of a session.
//
// The cost of "once" is that a file the user repairs mid-session keeps its
// finding until the next process — which is the same trade the stable element
// demands.
export function claimPromptFileScan(directory) {
  if (!nonEmptyString(directory) || scannedDirectories.has(directory)) return false
  scannedDirectories.add(directory)
  return true
}

// Test seam: clears the register, the per-project toast latches and the record of
// which directories have been scanned, mirroring `resetState` in state.js. Not part of the plugin contract — opencode never
// calls this.
export function resetOverrides() {
  findings.clear()
  toastedScopes.clear()
  scannedDirectories.clear()
}
