// Automatic compaction: the global switch this plugin writes into opencode's
// resolved config.
//
// opencode compacts a session when it crosses its own context threshold, and
// the decision reads ONE key: `compaction.auto`. There is no per-agent form of
// it — the agent-entry schema carries no compaction key, the overflow test
// reads the global value alone, and no hook can veto a compaction once it is
// started. The agent entry is not a substitute either: opencode's compaction
// path dereferences the fetched `compaction` agent without a guard, so a
// `disable: true` on it would turn an automatic compaction into a throw rather
// than into a skip (recorded at BUILTIN_AUTO_AGENTS, src/agents.js).
//
// So the plugin takes the switch: `auto: false`, in every agent mode,
// unconditionally. Compaction is a setting of this plugin from here on — off
// for every agent that does not carry its own `agentCompaction: true`
// (compactionEnabledFor, src/settings.js) — and the side that says ON is the
// plugin's own, driven through `client.session.summarize` at the threshold the
// agent already has.
//
// The write therefore reads NO setting. That is what keeps the per-agent switch
// live: opencode latches its config at instance bootstrap, so anything the
// global value depended on would need a restart to take effect, while a value
// that never enters this write can be read fresh at every crossing.
//
// The plugin wins over a project that set `compaction.auto: true` in its own
// `opencode.json`, on the same ground the solo-mode `title`/`summary` writes
// claim: the value is a user-facing setting of this plugin, and a project file
// that contradicted it would leave the user's own switch saying something that
// is not in effect.
//
// Not touched: the user's own `/compact` command, which is a compaction the
// user asked for and not an automatic one.

// Switches opencode's automatic compaction off in the resolved config. Every
// neighbouring key of the `compaction` object — `preserve_recent_tokens`,
// `reserved`, `prune`, `tail_turns` — is kept; a `compaction` value that is not
// a plain object (an array, a string, null) is replaced rather than merged
// into, the discipline suppressBuiltinAgentTurns uses for the same case.
// Mutates `config` in place. A config that is not an object is left alone.
export function applyCompactionPolicy(config) {
  if (!config || typeof config !== "object") return
  const existing =
    config.compaction && typeof config.compaction === "object" && !Array.isArray(config.compaction)
      ? config.compaction
      : null
  config.compaction = { ...existing, auto: false }
}
