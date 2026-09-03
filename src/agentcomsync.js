// Makes the `show agentcom` switch retroactive.
//
// The switch lives in the shared settings file
// (~/.config/opencode/agent-intercom.json, key `showAgentcom`) and is flipped
// by the companion TUI plugin, which is a separate package in a separate
// process: it writes the file and nothing else. The server-side plugin has no
// event for that write — settings.js re-reads the file behind a 2 s TTL cache
// and every consumer resolves the value when it needs it. So the flip is
// OBSERVED here, by comparing the resolved value against the last one seen, and
// a change is what triggers the sweep.
//
// The sweep itself is applyAgentcomVisibility (src/client.js), run over two
// sets of sessions:
//   - the sessions tracked as primaries (state.js `primarySessions`), which is
//     every orchestrator that has called one of the plugin's tools in this
//     process;
//   - the sessions this process has actually posted switch-governed traffic
//     into (client.js `agentcomSessionIds`). The fresh orchestrator a handoff
//     creates is the case the first set misses: it receives its kickoff before
//     it has ever called a tool.
// The spawn task prompt is the one plugin posting the switch never governed —
// it lands in the SUBAGENT's session and is that session's whole instruction.
// It is not hideable, so its session enters neither set and the sweep never
// reaches it.
//
// A session this process did not itself post into and that has not called a
// tool since — an old orchestrator session opened again after an opencode
// restart — is outside both sets, and its notices keep the flag they were
// posted with until it uses the plugin again.
//
// Everything is best-effort: a sweep that fails leaves the notices as they
// were, and the flip itself — which is a file write in another process — is
// unaffected either way.

import { getSettings } from "./settings.js"
import { primarySessions } from "./state.js"
import { agentcomSessionIds, applyAgentcomVisibility } from "./client.js"
import { log, errMsg } from "./log.js"

// How often the resolved setting is compared against the last value seen. The
// settings cache holds for 2 s, so this costs at most one small readFileSync
// per TTL window, and it bounds how long a notice stays on screen after the
// user turned the switch off.
export const AGENTCOM_WATCH_INTERVAL_MS = 1000

// The value the last observation resolved. `undefined` means nothing has been
// observed yet: the first observation only records, since no flip has happened
// that this process could act on.
let lastSeen
// One sweep at a time. A sweep walks a session's whole history and may issue a
// PATCH per stale part, which can outlive one tick; a second sweep started on
// top of it would fight the first over the same parts.
let sweeping = false
let timer = null

// Compares the switch against the last value seen and, on a change, brings
// every tracked primary's already-posted notices to the new visibility.
// `sessions` overrides the set swept (tests, and any caller that knows better
// than the tracked set). Returns what the observation did:
// { flipped, hidden, sessions } — `flipped` false means the value is unchanged
// or this was the first observation, and nothing was written.
export async function syncAgentcomVisibility(client, { sessions } = {}) {
  const show = getSettings().showAgentcom
  if (lastSeen === undefined) {
    lastSeen = show
    return { flipped: false, hidden: !show, sessions: 0 }
  }
  if (lastSeen === show) return { flipped: false, hidden: !show, sessions: 0 }
  // Advance BEFORE the sweep: a sweep that cannot write — a server without the
  // experimental part route, a refused request — must cost one attempt per
  // flip, not one per tick for the rest of the process's life.
  lastSeen = show
  const targets = sessions ?? [...new Set([...primarySessions, ...agentcomSessionIds()])]
  log("agentcom visibility flipped", { showAgentcom: show, sessions: targets.length })
  for (const sessionID of targets) {
    try {
      await applyAgentcomVisibility(client, sessionID, { hidden: !show })
    } catch (err) {
      // applyAgentcomVisibility swallows its own failures; this is the belt to
      // that braces, so one session can never end the sweep of the others.
      log("agentcom visibility sweep failed", { sessionID, err: errMsg(err) })
    }
  }
  return { flipped: true, hidden: !show, sessions: targets.length }
}

// Starts the observation loop. Idempotent: opencode calls the plugin factory
// once per session in one process, and one loop per process is what is wanted.
// The timer is unref'd so it never holds the process open.
export function startAgentcomVisibilityWatch(client, { intervalMs = AGENTCOM_WATCH_INTERVAL_MS } = {}) {
  if (timer) return timer
  // Seed from the value in effect at start, so a switch that was already off
  // when opencode came up is not read as a flip.
  lastSeen = getSettings().showAgentcom
  timer = setInterval(() => {
    if (sweeping) return
    sweeping = true
    void syncAgentcomVisibility(client)
      .catch((err) => log("agentcom visibility watch error", errMsg(err)))
      .finally(() => {
        sweeping = false
      })
  }, intervalMs)
  timer.unref?.()
  return timer
}

// Test-only: stops the loop and forgets the observed value, so the next start
// or sync begins from nothing. Not part of the plugin contract.
export function resetAgentcomVisibilityWatch() {
  if (timer) clearInterval(timer)
  timer = null
  lastSeen = undefined
  sweeping = false
}
