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
// Three consumers read it: the debug log at detection, a once-per-process
// toast, and a block in the primary's stable system prompt telling the
// orchestrator to report the finding to the user. The register itself never
// refuses anything and never touches a user's file — it only records what was
// found so those three can say it.
//
// Process-scoped, like every other map in state.js: findings from a subagent's
// directory scan are reported through the primary's block, because both live in
// the same opencode process.
//
// Pure: no fs, no client, no log. Locating the offending file is the detector's
// job and arrives here as a ready-made `file` value.

// key (`<kind>\0<agent>`) -> normalized finding. A Map, so a re-detection of
// the same collision cannot add a second line: `installAgents` is idempotent
// and re-reports the same entry on every run, and the prompt-file scan re-runs
// per directory.
const findings = new Map()

// Whether overrideToastText() has already handed its one-shot body out.
let toastShown = false

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

function keyOf(kind, agent) {
  return `${kind}\u0000${agent}`
}

// Writes a normalized finding under its `kind + agent` key.
//
// Returns true when the register CHANGED — the finding is new, or it differs
// from the one already stored under that key (a rescan after the user edited
// the file). Returns false for an exact repeat and for a finding with no usable
// agent name, so a caller can log and toast on a change without having to
// remember what it already saw.
function record(kind, input) {
  const agent = oneLine(input?.agent)
  if (!agent) return false
  const finding = Object.freeze({
    kind,
    agent,
    fields: Object.freeze(kind === KIND_AGENT_ENTRY ? stringList(input?.fields) : []),
    missing: Object.freeze(kind === KIND_PROMPT_FILE ? stringList(input?.missing) : []),
    file: nonEmptyString(input?.file) ? input.file : null,
    detail: oneLine(input?.detail),
  })
  const key = keyOf(kind, agent)
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

// A project agent entry displaced the plugin's role. `fields` names the fields
// of the plugin's role the project entry carries its own value for, `file` the
// markdown file it was found in or null when the entry has no file (an
// `opencode.json` entry), `detail` an optional one-line replacement for the
// generated wording.
export function recordAgentEntryOverride(finding) {
  return record(KIND_AGENT_ENTRY, finding)
}

// A `.opencode/agent-intercom/<agent>.md` template is missing contract elements
// the current prompt would inject. `missing` names the probe ids that did not
// match.
export function recordPromptFileOverride(finding) {
  return record(KIND_PROMPT_FILE, finding)
}

// Whether anything at all has been found in this process.
export function hasFindings() {
  return findings.size > 0
}

// Every finding, in render order. Frozen records in a fresh array: the log
// outlet reads them per finding, and no consumer can reshape the register by
// holding on to what it got.
export function overrideFindings() {
  return [...findings.values()].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      a.agent.localeCompare(b.agent),
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

// The block for the primary's stable system prompt: every finding by name, and
// the instruction to pass it on. Empty string when there is nothing to report,
// so the caller can append it unconditionally.
//
// Its text depends on the findings alone, so it holds its bytes for as long as
// the finding set does — which is what lets it live in the cached stable
// element instead of costing a breakpoint every turn.
export function overrideBlock() {
  if (findings.size === 0) return ""
  const lines = overrideFindings().map(
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

// The one-shot toast body, or null when there is nothing to report or the toast
// has already been handed out in this process. The title and the variant belong
// to the call site; this is the message alone.
export function overrideToastText() {
  if (findings.size === 0 || toastShown) return null
  const all = overrideFindings()
  const overridden = all.filter((f) => f.kind === KIND_AGENT_ENTRY).length
  const stale = all.length - overridden
  const parts = []
  if (overridden) parts.push(`${overridden} role${overridden === 1 ? "" : "s"} overridden by project files`)
  if (stale) parts.push(`${stale} prompt file${stale === 1 ? "" : "s"} out of date`)
  toastShown = true
  return `${parts.join(", ")} — see the orchestrator's first answer`
}

// Test seam: clears the register and the one-shot toast latch, mirroring
// `resetState` in state.js. Not part of the plugin contract — opencode never
// calls this.
export function resetOverrides() {
  findings.clear()
  toastShown = false
}
