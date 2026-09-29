#!/bin/bash
# The throwaway opencode configuration an end-to-end run is carried out in, and
# the model audit that checks what actually answered.
#
# Sourced, never executed, beside server-lifecycle.sh:
#
#   HERE=$(cd "$(dirname "$0")" && pwd)
#   . "$HERE/server-lifecycle.sh"
#   . "$HERE/config-isolation.sh"
#
# Two rules this library exists for.
#
# 1. A run changes no opencode setting of the machine. Every file the drivers
#    used to read or write under ~/.config/opencode — opencode.json, tui.json,
#    llm-models.json, agent-intercom.json — is built fresh under a temporary
#    HOME, and the server is started with that HOME. The machine's own config
#    directory is read once, to carry the provider definitions and the search
#    credentials over, and never written.
#
#    HOME, not XDG_CONFIG_HOME, is the lever: the plugin resolves its three
#    files through `os.homedir()` (src/llmmodel.js, src/settings.js,
#    src/llmparams.js) and its cache through the same (src/log.js), so an
#    XDG_CONFIG_HOME alone would move opencode's config and leave the plugin
#    reading the machine's llm-models.json. Node's os.homedir() honours $HOME on
#    POSIX, so one variable moves both.
#
#    What the isolated home does NOT move, deliberately:
#      .local/share  → symlinked to the real one. It holds auth.json and
#                      opencode.db; a fresh one has no provider credentials and
#                      no run could authenticate.
#      .cache        → symlinked to the real one, so the plugin's debug log
#                      stays at ~/.cache/opencode-agent-intercom/debug.log
#                      unless OPENCODE_AGENT_INTERCOM_DEBUG_LOG points it
#                      elsewhere. The cache is shared: every state file the
#                      plugin keeps under cacheDir() — the endless-cycles
#                      ledger, the notice journal, cached result files, the
#                      pause file, the TUI route file — lands in the real
#                      ~/.cache/opencode-agent-intercom/ too. That breaks
#                      rule 1 as much as a written setting would; it is an
#                      open defect (todos.md), not a harmless exception.
#      .local/state  → NOT symlinked. `applyModelChoices` writes opencode's
#                      per-model variant store there (src/variantstore.js), and
#                      that is machine state a run must not rewrite.
#
# 2. A run uses the pinned model and nothing else. E2E_MODEL reaches an agent
#    only through llm-models.json: `applyModelChoices` (src/llmmodel.js) writes
#    the entry into `config.agent[<name>].model` at instance bootstrap, and that
#    beats the `model` a driver names in its POST — a live run was answered by
#    the machine's `gpuserver/Qwen3.8 Flash Next` although the request named
#    another model. The isolated llm-models.json therefore pins every agent the
#    plugin installs and every built-in that can answer a turn, with no
#    `variant` key, and the isolated opencode.json sets `model` and
#    `small_model` for anything not named there at all.
#
#    `grounder` is the one exception (E2E_PIN_EXEMPT_AGENTS): it holds
#    `grounded_search`, which answers through Google's Gemini Search grounding,
#    and pinning it at the test model takes its provider away and the tool
#    cannot work. For an exempt agent the machine's own llm-models.json entry
#    is carried over verbatim, `variant` included; where the machine names no
#    entry for it, the isolated file names none either and that agent falls
#    back to opencode.json's top-level `model` like anything unnamed there.
#
#    e2e_model_audit then reads back what answered: every assistant message the
#    run can still see carries `providerID`/`modelID`, and a model other than
#    the pinned one fails the run.
#
# State the functions set:
#
#   E2E_MODEL_REF / E2E_MODEL_PROVIDER / E2E_MODEL_ID   the resolved pin,
#                             kept across a further source in the same process
#   E2E_MODEL_OWNER           the pid the pin was resolved for
#   E2E_VISION_MODEL_REF / E2E_VISION_MODEL_PROVIDER / E2E_VISION_MODEL_ID
#                             the resolved E2E_VISION_MODEL, "" where it is
#                             unset — set by e2e_resolve_vision_model
#   E2E_AGENT_PINS            the agents pinned to a model of their own, as
#                             `agent=provider/model` words — written by
#                             e2e_iso_pin_agent, read by the model audit
#   E2E_ISO_HOME              the temporary HOME, removed by e2e_iso_remove
#   E2E_ISO_CONFIG_HOME       $E2E_ISO_HOME/.config, exported
#   E2E_ISO_OPENCODE_DIR      its opencode/ directory
#   E2E_ISO_SETTINGS_FILE     the isolated agent-intercom.json
#   E2E_ISO_MODELS_FILE       the isolated llm-models.json
#                             — these five are exported, so a driver another
#                             driver invokes reads the same isolated files
#   E2E_ISO_OWNER             the pid that built the home; NOT exported, so only
#                             that process removes it again
#   E2E_SERVER_ENV            the assignments e2e_server_start puts in front of
#                             the server process
#
# Requires: python3, curl, cp, mktemp.

# The model every driver runs on unless E2E_MODEL names another. qwen3.8-flash-
# medium on `cliproxy` (the same model the plugin runs on, src/index.js): both
# providers this machine enables — cliproxy and gpuserver — are carried into the
# isolated config, and gpuserver's model is the banned one, so cliproxy is the
# provider a default can name; this pair is proven reachable and reasoning-capable.
E2E_DEFAULT_MODEL="cliproxy/qwen3.8-flash-medium"

# The model no run may use, whatever the rest of the machine is configured
# with. Named here so the refusal reads as itself in a driver's output.
E2E_BANNED_MODEL="gpuserver/Qwen3.8 Flash Next"

# Every agent name the pin is written for: the roles this plugin installs
# (src/agents.js AGENTS) minus the exempt ones below, plus the opencode
# built-ins that can answer a turn of their own. `applyModelChoices` only
# touches names that are already in `config.agent`, so a name no build knows
# costs nothing.
E2E_PINNED_AGENTS="orchestrator planner coder debugger reviewer documenter researcher designer gitter scout refuter checker verifier releaser build plan general title summary compaction"

# The agents the pin does NOT reach, and why `grounder` is one of them: it
# holds `grounded_search`, whose answer comes through Google's Gemini Search
# grounding, and a pin at the test model would take that provider away from
# the tool. An exempt agent keeps the machine's own llm-models.json entry —
# verbatim, `variant` included — or no entry at all where the machine has
# none, falling back to opencode.json's top-level `model` like any unnamed
# agent.
E2E_PIN_EXEMPT_AGENTS="grounder"

# The keys carried over from the machine's agent-intercom.json into the
# isolated one: the search endpoint and credentials a run needs to reach the
# web, and nothing that decides behaviour under test.
E2E_CARRIED_SETTINGS="searxngUrl exaApiKey forumBangs"

# The resolved pin, keyed on the process like the audit manifest below and for
# the same reason: sourcing this library a second time inside the SAME process
# keeps a pin e2e_resolve_model has already validated, so a driver that reaches
# the library through lib/midrun-common.sh and also sources it directly does not
# lose it between the two. Any other process starts without a pin: these three
# are not exported, and a value that arrives from outside anyway has not been
# through the banned-model refusal, so it is dropped rather than adopted.
E2E_MODEL_OWNER="${E2E_MODEL_OWNER:-}"
if [ "$E2E_MODEL_OWNER" != "$$" ] || [ -z "${E2E_MODEL_REF:-}" ]; then
  E2E_MODEL_REF=""
  E2E_MODEL_PROVIDER=""
  E2E_MODEL_ID=""
  E2E_MODEL_OWNER=""
fi

# The isolated configuration, KEPT when it arrives exported. e2e_iso_create
# exports these five precisely so a driver that another driver invokes resolves
# the same isolated files: run-all.sh builds the home, and run-task.sh,
# multi-task.sh, message-task.sh and ask-task.sh then read the configuration in
# force through e2e_opencode_config_dir. Blanking them here would send every one
# of those back to the machine's ~/.config/opencode while the server runs on
# another set, which is exactly what rule 1 above forbids.
#
# The "already built" marker is the isolated opencode directory itself, on disk:
# a set is kept only when it is complete AND that directory exists, so a stale
# set left in the environment by a run whose home is long gone is dropped rather
# than followed to a path that is not there.
#
# This is deliberately NOT the pin's rule above, and cannot be confused with it.
# The pin is keyed on $$ and is dropped when it arrives from another process,
# because a model reference from outside has not been through the banned-model
# refusal and nothing about the value itself can show whether it has. These five
# are paths: what they claim is checkable on the spot, and a driver that built
# nothing MUST take its caller's set or it reads the wrong configuration. The
# pin travels between processes through E2E_MODEL, which every driver resolves
# again; the isolated home cannot be built again, so it travels as itself.
E2E_ISO_HOME="${E2E_ISO_HOME:-}"
E2E_ISO_CONFIG_HOME="${E2E_ISO_CONFIG_HOME:-}"
E2E_ISO_OPENCODE_DIR="${E2E_ISO_OPENCODE_DIR:-}"
E2E_ISO_SETTINGS_FILE="${E2E_ISO_SETTINGS_FILE:-}"
E2E_ISO_MODELS_FILE="${E2E_ISO_MODELS_FILE:-}"
if [ -z "$E2E_ISO_HOME" ] || [ -z "$E2E_ISO_CONFIG_HOME" ] || [ ! -d "$E2E_ISO_OPENCODE_DIR" ]; then
  E2E_ISO_HOME=""
  E2E_ISO_CONFIG_HOME=""
  E2E_ISO_OPENCODE_DIR=""
  E2E_ISO_SETTINGS_FILE=""
  E2E_ISO_MODELS_FILE=""
fi

# Removal is owned, not inherited: the pid that built the home is the only one
# that removes it. E2E_ISO_OWNER is never exported, so a driver that inherited
# the five paths above holds no claim on them — see e2e_iso_remove. A further
# source of this library inside the building process keeps the claim.
E2E_ISO_OWNER="${E2E_ISO_OWNER:-}"

# Never inherited: an array cannot be exported, and only a driver that starts a
# server of its own needs it — that driver calls e2e_iso_create itself.
E2E_SERVER_ENV=()

# server-lifecycle.sh defines these two; standalone sourcing gets its own.
type e2e_say >/dev/null 2>&1 || e2e_say() { printf '%s\n' "$*"; }
type e2e_fail >/dev/null 2>&1 || e2e_fail() { printf '%s\n' "$*" >&2; }

# ---------- where the config in force lives --------------------------------

# The opencode config directory this harness reads: the isolated one once
# e2e_iso_create has run, the machine's until then. Every driver and every
# wiring check goes through this, so none of them can look at the machine's
# files while the server is running against another set.
e2e_opencode_config_dir() {
  if [ -n "${E2E_ISO_CONFIG_HOME:-}" ]; then
    printf '%s/opencode' "$E2E_ISO_CONFIG_HOME"
    return 0
  fi
  printf '%s/opencode' "${XDG_CONFIG_HOME:-${HOME:-}/.config}"
}

# The machine's own opencode config directory — read to carry providers and
# credentials over, never written.
e2e_machine_config_dir() {
  printf '%s/opencode' "${E2E_MACHINE_CONFIG_HOME:-${XDG_CONFIG_HOME:-${HOME:-}/.config}}"
}

# The plugin's debug log of the run. OPENCODE_AGENT_INTERCOM_DEBUG_LOG
# redirects it (src/log.js reads the same env); unset, it is the shared cache
# path every driver slices.
e2e_debug_log() {
  if [ -n "${OPENCODE_AGENT_INTERCOM_DEBUG_LOG:-}" ]; then
    printf '%s' "$OPENCODE_AGENT_INTERCOM_DEBUG_LOG"
    return 0
  fi
  printf '%s/.cache/opencode-agent-intercom/debug.log' "${HOME:-}"
}

# ---------- the model pin --------------------------------------------------

# Resolves E2E_MODEL into E2E_MODEL_REF/PROVIDER/ID and refuses the banned
# model outright, before anything is started. Exports E2E_MODEL so a driver
# this one sequences resolves the same pin, and marks E2E_MODEL_OWNER with the
# pid, so a further source of this library inside the same process keeps the pin
# instead of blanking it.
e2e_resolve_model() {
  local ref=${E2E_MODEL:-$E2E_DEFAULT_MODEL}
  local provider=${ref%%/*} id=${ref#*/}
  if [ -z "$provider" ] || [ "$id" = "$ref" ] || [ -z "$id" ]; then
    e2e_fail "E2E_MODEL must be a provider/model pair (got: $ref)"
    return 1
  fi
  if [ "$ref" = "$E2E_BANNED_MODEL" ]; then
    e2e_fail "E2E_MODEL names $E2E_BANNED_MODEL — no end-to-end run may use that model."
    return 1
  fi
  E2E_MODEL_REF="$ref"
  E2E_MODEL_PROVIDER="$provider"
  E2E_MODEL_ID="$id"
  E2E_MODEL_OWNER=$$
  E2E_MODEL="$ref"
  export E2E_MODEL
  return 0
}

# Resolves E2E_VISION_MODEL — a model with image input, form provider/model,
# taken as given — into E2E_VISION_MODEL_REF/PROVIDER/ID. Unset is not an
# error: the three stay "" and a driver that needs a model that sees reports
# the step that needs it as skipped. A malformed value and the banned model are
# refused, like E2E_MODEL.
e2e_resolve_vision_model() {
  E2E_VISION_MODEL_REF=""
  E2E_VISION_MODEL_PROVIDER=""
  E2E_VISION_MODEL_ID=""
  local ref=${E2E_VISION_MODEL:-}
  [ -n "$ref" ] || return 0
  local provider=${ref%%/*} id=${ref#*/}
  if [ -z "$provider" ] || [ "$id" = "$ref" ] || [ -z "$id" ]; then
    e2e_fail "E2E_VISION_MODEL must be a provider/model pair (got: $ref)"
    return 1
  fi
  if [ "$ref" = "$E2E_BANNED_MODEL" ]; then
    e2e_fail "E2E_VISION_MODEL names $E2E_BANNED_MODEL — no end-to-end run may use that model."
    return 1
  fi
  E2E_VISION_MODEL_REF="$ref"
  E2E_VISION_MODEL_PROVIDER="$provider"
  E2E_VISION_MODEL_ID="$id"
  return 0
}

# Whether the opencode.json in force declares image input for a model:
# `modalities.input` of its provider entry holds "image". 0 when it does, 1
# when it does not or the model is not declared there — the reading opencode
# itself takes, where a model without the key cannot see.
# Usage: e2e_model_has_image_input <provider/model>
e2e_model_has_image_input() {
  local ref="$1"
  python3 -c '
import json, sys
path, provider, model_id = sys.argv[1:4]
try:
    with open(path) as handle:
        config = json.load(handle)
    entry = config["provider"][provider]["models"][model_id]
    modalities = entry.get("modalities") or {}
    sys.exit(0 if "image" in (modalities.get("input") or []) else 1)
except Exception:
    sys.exit(1)
' "$(e2e_opencode_config_dir)/opencode.json" "${ref%%/*}" "${ref#*/}" 2>/dev/null
}

E2E_AGENT_PINS="${E2E_AGENT_PINS:-}"

# Pins one agent to a model of its own in the isolated llm-models.json, apart
# from E2E_MODEL, and records the pin for the model audit, which then holds
# that agent's turns to it. The file is read at instance bootstrap, so the pin
# reaches the next server the driver starts, not one already running. The
# banned model is refused. Pinning an agent to E2E_MODEL itself takes its own
# pin back off.
# Usage: e2e_iso_pin_agent <agent> <provider/model>
e2e_iso_pin_agent() {
  local agent="$1" ref="$2"
  local provider=${ref%%/*} id=${ref#*/}
  local word kept=""
  if [ -z "${E2E_ISO_MODELS_FILE:-}" ] || [ ! -f "$E2E_ISO_MODELS_FILE" ]; then
    e2e_fail "e2e_iso_pin_agent: no isolated llm-models.json — call e2e_iso_create first"
    return 1
  fi
  if [ -z "$agent" ] || [ -z "$provider" ] || [ "$id" = "$ref" ] || [ -z "$id" ]; then
    e2e_fail "e2e_iso_pin_agent: usage <agent> <provider/model> (got: $agent $ref)"
    return 1
  fi
  if [ "$ref" = "$E2E_BANNED_MODEL" ]; then
    e2e_fail "e2e_iso_pin_agent: $E2E_BANNED_MODEL is banned — no end-to-end run may use that model."
    return 1
  fi
  python3 -c '
import json, sys
path, agent, provider, model_id = sys.argv[1:5]
with open(path) as handle:
    models = json.load(handle)
models[agent] = {"providerID": provider, "modelID": model_id}
with open(path, "w") as handle:
    json.dump(models, handle, indent=2)
    handle.write("\n")
' "$E2E_ISO_MODELS_FILE" "$agent" "$provider" "$id" || {
    e2e_fail "e2e_iso_pin_agent: could not write $E2E_ISO_MODELS_FILE"
    return 1
  }
  for word in $E2E_AGENT_PINS; do
    [ "${word%%=*}" = "$agent" ] || kept="$kept $word"
  done
  [ "$ref" = "$E2E_MODEL_REF" ] || kept="$kept $agent=$ref"
  E2E_AGENT_PINS="${kept# }"
  e2e_say "isolated config: $agent pinned to $ref (from the next server start)"
  return 0
}

# ---------- the isolated home ----------------------------------------------

# Usage: e2e_iso_create <plugin_root> [settings_json]
#
# Builds the throwaway home and leaves E2E_ISO_* and E2E_SERVER_ENV set.
# <settings_json> is the isolated agent-intercom.json the driver wants; the
# carried-over credential keys are merged UNDER it, so a driver's own value for
# a key always wins. Defaults to the suite's own setup when omitted.
#
# The caller must have run e2e_resolve_model.
e2e_iso_create() {
  local plugin_root="$1"
  # Assigned in two steps on purpose: a default written inside ${2:-…} would be
  # cut at the first `}` of the JSON and the rest appended as literal text.
  local settings_json="$2"
  [ -n "$settings_json" ] ||
    settings_json='{"maxSubagents":8,"maxContext":130000,"endlessMode":false,"agentMode":"orchestrator"}'
  local machine_dir iso_dir

  if [ -z "$E2E_MODEL_REF" ]; then
    e2e_fail "e2e_iso_create: call e2e_resolve_model first — the isolated config is built around the pin"
    return 1
  fi
  if [ ! -d "$plugin_root" ]; then
    e2e_fail "e2e_iso_create: no such plugin root: $plugin_root"
    return 1
  fi
  command -v python3 >/dev/null || { e2e_fail "e2e_iso_create: python3 is not on PATH"; return 1; }

  machine_dir=$(e2e_machine_config_dir)
  E2E_ISO_HOME=$(mktemp -d "${TMPDIR:-/tmp}/e2e-opencode-home.XXXXXXXX") || {
    e2e_fail "e2e_iso_create: could not create a temporary home"
    return 1
  }
  chmod 700 "$E2E_ISO_HOME"
  E2E_ISO_CONFIG_HOME="$E2E_ISO_HOME/.config"
  E2E_ISO_OPENCODE_DIR="$E2E_ISO_CONFIG_HOME/opencode"
  iso_dir="$E2E_ISO_OPENCODE_DIR"
  mkdir -p "$iso_dir" "$E2E_ISO_HOME/.local/state" || { e2e_fail "e2e_iso_create: mkdir failed under $E2E_ISO_HOME"; return 1; }

  # auth.json and opencode.db: shared with the machine so a run authenticates.
  # The .cache link shares the plugin's real cache dir — the plugin's state
  # files land in it too; open defect, see the header and todos.md.
  ln -s "${HOME}/.local/share" "$E2E_ISO_HOME/.local/share" || {
    e2e_fail "e2e_iso_create: could not link $E2E_ISO_HOME/.local/share to ${HOME}/.local/share — without auth.json no provider authenticates"
    return 1
  }
  ln -s "${HOME}/.cache" "$E2E_ISO_HOME/.cache" || {
    e2e_fail "e2e_iso_create: could not link $E2E_ISO_HOME/.cache to ${HOME}/.cache — the drivers read the plugin's debug log there"
    return 1
  }

  # opencode resolves a provider's npm package out of its config directory. A
  # hardlinked copy costs no space and no download; a package manager that does
  # install replaces files rather than writing through the link. Copying it is
  # what keeps a run from having to reach npm at all.
  if [ -d "$machine_dir/node_modules" ]; then
    cp -al "$machine_dir/node_modules" "$iso_dir/node_modules" 2>/dev/null ||
      cp -a "$machine_dir/node_modules" "$iso_dir/node_modules" 2>/dev/null ||
      e2e_say "note: could not copy $machine_dir/node_modules — opencode will install the provider packages into $iso_dir itself"
  fi
  for f in package.json package-lock.json AGENTS.md; do
    [ -f "$machine_dir/$f" ] && cp "$machine_dir/$f" "$iso_dir/$f"
  done

  python3 - "$machine_dir" "$iso_dir" "$plugin_root" "$E2E_MODEL_PROVIDER" "$E2E_MODEL_ID" \
      "$E2E_PINNED_AGENTS" "$E2E_PIN_EXEMPT_AGENTS" "$E2E_CARRIED_SETTINGS" "$settings_json" <<'PY' || {
import json, os, sys

machine, iso, plugin_root, provider, model_id, agents, exempt, carried, settings_json = sys.argv[1:10]
ref = f"{provider}/{model_id}"


def load(path):
    try:
        with open(path) as handle:
            raw = json.load(handle)
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def write(name, data):
    with open(os.path.join(iso, name), "w") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")


# opencode.json: the machine's providers, this plugin wired, and the pin as the
# instance default for every agent the file below does not name. Anything that
# could carry a model of its own is dropped: a per-agent `model`, and the two
# top-level keys are overwritten rather than merged.
config = load(os.path.join(machine, "opencode.json"))
if not config.get("provider"):
    print(
        f"warning: {machine}/opencode.json defines no providers — "
        f"the isolated config carries none either and {ref} will not resolve",
        file=sys.stderr,
    )
agent = config.get("agent")
if isinstance(agent, dict):
    for entry in agent.values():
        if isinstance(entry, dict):
            entry.pop("model", None)
            entry.pop("variant", None)
config["plugin"] = [plugin_root]
config["model"] = ref
config["small_model"] = ref
config.setdefault("permission", "allow")
write("opencode.json", config)

# tui.json: the TUI half reads a plugin list of its own.
write("tui.json", {"plugin": [plugin_root]})

# llm-models.json: the file applyModelChoices reads. Every agent on the pin,
# and no `variant` — a reasoning effort of the machine's is a setting of the
# machine's, not of the run. Except the exempt agents: `grounder` keeps the
# machine's own entry verbatim, variant included, because the test pin would
# take away the provider its `grounded_search` answers through; where the
# machine names no entry for it, none is written and the agent falls back to
# opencode.json's top-level model.
machine_models = load(os.path.join(machine, "llm-models.json"))
models = {}
for name in agents.split():
    models[name] = {"providerID": provider, "modelID": model_id}
for name in exempt.split():
    entry = machine_models.get(name)
    if isinstance(entry, dict):
        models[name] = entry
write("llm-models.json", models)

# agent-intercom.json: what the driver asked for, over the credential keys
# carried from the machine.
try:
    wanted = json.loads(settings_json)
    if not isinstance(wanted, dict):
        raise ValueError("not an object")
except Exception as err:
    print(f"e2e_iso_create: settings JSON is not an object: {err}", file=sys.stderr)
    sys.exit(1)
settings = {}
machine_settings = load(os.path.join(machine, "agent-intercom.json"))
for key in carried.split():
    if key in machine_settings:
        settings[key] = machine_settings[key]
settings.update(wanted)
write("agent-intercom.json", settings)
PY
    e2e_fail "e2e_iso_create: could not write the isolated configuration under $iso_dir"
    return 1
  }

  E2E_ISO_SETTINGS_FILE="$iso_dir/agent-intercom.json"
  E2E_ISO_MODELS_FILE="$iso_dir/llm-models.json"
  # Exported, so every driver this one invokes resolves this configuration and
  # not the machine's. E2E_ISO_OWNER stays unexported: the paths travel, the
  # claim to remove them does not.
  export E2E_ISO_HOME E2E_ISO_CONFIG_HOME E2E_ISO_OPENCODE_DIR E2E_ISO_SETTINGS_FILE E2E_ISO_MODELS_FILE
  E2E_ISO_OWNER=$$

  # What e2e_server_start puts in front of the opencode process. XDG_DATA_HOME
  # and XDG_CACHE_HOME are named explicitly so an ambient value of the caller's
  # cannot point the server somewhere else.
  E2E_SERVER_ENV=(
    "HOME=$E2E_ISO_HOME"
    "XDG_CONFIG_HOME=$E2E_ISO_CONFIG_HOME"
    "XDG_DATA_HOME=$E2E_ISO_HOME/.local/share"
    "XDG_STATE_HOME=$E2E_ISO_HOME/.local/state"
    "XDG_CACHE_HOME=$E2E_ISO_HOME/.cache"
  )
  if [ -n "${OPENCODE_AGENT_INTERCOM_DEBUG_LOG:-}" ]; then
    E2E_SERVER_ENV+=("OPENCODE_AGENT_INTERCOM_DEBUG_LOG=$OPENCODE_AGENT_INTERCOM_DEBUG_LOG")
  fi

  e2e_say "isolated config: $iso_dir (model pin $E2E_MODEL_REF, every agent except${E2E_PIN_EXEMPT_AGENTS:+ $E2E_PIN_EXEMPT_AGENTS}; the machine's ~/.config/opencode is untouched)"
  return 0
}

# Removes the isolated home. The two symlinks inside it are removed as links —
# rm never follows one — so the machine's .cache and .local/share are safe.
# A no-op when no home was created, and idempotent.
#
# A home built by ANOTHER process is left standing. A driver that run-all.sh or
# nested-task.sh invokes inherits the exported paths, and several of those
# drivers install a cleanup trap before building a home of their own: without
# this guard an early exit of theirs would take the caller's live configuration
# with it, out from under the server still reading it.
e2e_iso_remove() {
  [ -n "${E2E_ISO_HOME:-}" ] || return 0
  case "$E2E_ISO_HOME" in
    /tmp/e2e-opencode-home.*|"${TMPDIR%/}"/e2e-opencode-home.*) : ;;
    *)
      e2e_fail "e2e_iso_remove: refusing to remove $E2E_ISO_HOME — not a home this library created"
      return 1
      ;;
  esac
  if [ "${E2E_ISO_OWNER:-}" != "$$" ]; then
    e2e_say "isolated config kept ($E2E_ISO_HOME) — it was built by the driver that invoked this one, which removes it itself"
    return 0
  fi
  rm -rf -- "$E2E_ISO_HOME" && e2e_say "isolated config removed ($E2E_ISO_HOME)"
  E2E_ISO_HOME=""
  E2E_ISO_CONFIG_HOME=""
  E2E_ISO_OPENCODE_DIR=""
  E2E_ISO_SETTINGS_FILE=""
  E2E_ISO_MODELS_FILE=""
  E2E_ISO_OWNER=""
  E2E_SERVER_ENV=()
  E2E_AGENT_PINS=""
  unset E2E_ISO_HOME E2E_ISO_CONFIG_HOME E2E_ISO_OPENCODE_DIR E2E_ISO_SETTINGS_FILE E2E_ISO_MODELS_FILE
  return 0
}

# ---------- the model audit ------------------------------------------------

# The captures one driver invocation is audited over.
#
# The audit may only read message trees THIS driver invocation wrote. The out
# directory is shared between the drivers and between runs and is never emptied,
# so a glob over it also matches what other drivers and earlier runs left behind
# — turns that answered on whatever model those runs pinned, and which then read
# as foreign models the present invocation never used. Every driver therefore
# records each capture as it writes it and is audited over exactly that list.
#
# The list is kept in a file rather than in a variable because several drivers
# take a capture inside a command substitution (`FLAT=$(mr_capture …)`), whose
# subshell cannot write the parent's variables. The subshell inherits the
# variable holding the path, so parent and subshell name the same file.
#
# The file is keyed on the driver invocation, not on a name another invocation
# could arrive at: `mktemp` hands every one a fresh name of its own, so the eight
# `run-task.sh` invocations `run-all.sh` sequences keep eight separate lists, and
# a manifest left in TMPDIR by an earlier run carries a name this one cannot
# produce again and is therefore never read. E2E_AUDIT_OWNER holds the pid the
# manifest was made for: sourcing this library a second time inside the SAME
# process keeps the list already in hand, so a capture recorded before that
# second source survives it, while any other process — including one the two
# variables were exported to — gets a manifest of its own.
E2E_AUDIT_MANIFEST="${E2E_AUDIT_MANIFEST:-}"
E2E_AUDIT_OWNER="${E2E_AUDIT_OWNER:-}"
if [ "$E2E_AUDIT_OWNER" != "$$" ] || [ -z "$E2E_AUDIT_MANIFEST" ] || [ ! -f "$E2E_AUDIT_MANIFEST" ]; then
  E2E_AUDIT_MANIFEST=$(mktemp "${TMPDIR:-/tmp}/e2e-audit-captures.$(basename -- "${0:-driver}" .sh).XXXXXXXX" 2>/dev/null) ||
    E2E_AUDIT_MANIFEST="${TMPDIR:-/tmp}/e2e-audit-captures.$$-$(date +%s%N)"
  : > "$E2E_AUDIT_MANIFEST" 2>/dev/null || :
  E2E_AUDIT_OWNER=$$
fi

# Usage: e2e_audit_record <json_file> [json_file ...]
#
# Records a capture this run wrote. Recording the same path again is harmless:
# the audit reads the manifest deduplicated, so a capture rewritten inside a
# poll loop is audited once.
e2e_audit_record() {
  local path
  for path in "$@"; do
    [ -n "$path" ] || continue
    printf '%s\n' "$path" >> "$E2E_AUDIT_MANIFEST" 2>/dev/null || :
  done
  return 0
}

# Usage: e2e_audit_recorded <label> <report_file>
#
# Audits exactly the captures e2e_audit_record was given, in the order they were
# first recorded. An empty manifest fails with status 2 instead of passing: a run
# that recorded no capture has shown no turn of its own to have answered on the
# pin. E2E_AUDIT_LINE carries the evidence line either way, as with
# e2e_model_audit.
e2e_audit_recorded() {
  local label="$1" report="$2"
  local -a files=()
  local path
  while IFS= read -r path; do
    [ -n "$path" ] && files+=("$path")
  done < <(awk 'NF && !seen[$0]++' "$E2E_AUDIT_MANIFEST" 2>/dev/null)
  if [ "${#files[@]}" -eq 0 ]; then
    E2E_AUDIT_LINE="$label: no capture of this run was recorded, so no turn of it can be shown to have answered on $E2E_MODEL_REF"
    printf 'FAIL  model-pin (%s)\n      %s\n' "$label" "$E2E_AUDIT_LINE" | tee -a "$report"
    return 2
  fi
  e2e_model_audit "$label" "$report" "${files[@]}"
}

# Usage: e2e_audit_fetch_sessions <base_url> <out_prefix> <sid> [sid ...]
#
# Writes each session's message tree to <out_prefix>.audit-<sid>.json, skipping
# a session that no longer answers with a non-empty list — a subagent session is
# deleted the moment it finishes, and a 404 must not overwrite a snapshot taken
# while it was alive. Prints the files it wrote, one per line, and records each
# of them for the audit.
e2e_audit_fetch_sessions() {
  local base="$1" prefix="$2" sid file tmp
  shift 2
  for sid in "$@"; do
    [ -n "$sid" ] || continue
    file="$prefix.audit-$sid.json"
    tmp="$file.tmp"
    curl -s -m 60 "$base/session/$sid/message" > "$tmp" 2>/dev/null
    if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if isinstance(d,list) and d else 1)' "$tmp" 2>/dev/null; then
      mv "$tmp" "$file"
      e2e_audit_record "$file"
      printf '%s\n' "$file"
    else
      rm -f "$tmp"
    fi
  done
}

# Usage: e2e_audit_subagent_sids <slice_file>
#
# The session ids of every subagent this run spawned, off the plugin's own
# `spawned` lines in a debug-log slice. Printed one per line, deduplicated.
# A driver calls it while its subagents are still alive: their sessions are
# deleted when they finish and a transcript read afterwards is a 404.
e2e_audit_subagent_sids() {
  local slice="$1"
  [ -f "$slice" ] || return 0
  grep -o '"sessionID":"[^"]*"' "$slice" 2>/dev/null | sed 's/.*:"//; s/"$//' | sort -u
}

# Usage: e2e_model_audit <label> <report_file> <json_file> [json_file ...]
#
# Reads every assistant message in the given capture files and compares the
# model that answered against the pin. Returns 0 when every message names it,
# 1 when any names another (the banned model included), 2 when the files hold no
# assistant message at all — nothing audited is a failure, not a pass, because
# an audit over an empty capture would pass whatever the run did.
#
# An agent e2e_iso_pin_agent pinned to a model of its own is held to that model
# (E2E_AGENT_PINS, each word passed as --agent-model).
#
# The agents of E2E_PIN_EXEMPT_AGENTS are passed to the audit as exempt: their
# turns ran on the machine's entry rather than the pin by design, and an
# off-pin turn of one of them is allowed and reported separately — the banned
# model stays refused for them too.
#
# E2E_AUDIT_LINE carries the one-line evidence either way.
E2E_AUDIT_LINE=""
e2e_model_audit() {
  local label="$1" report="$2" status
  shift 2
  local lib word
  local -a own_pins=()
  for word in ${E2E_AGENT_PINS:-}; do
    own_pins+=(--agent-model "$word")
  done
  lib=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib
  E2E_AUDIT_LINE=$(python3 "$lib/model-audit.py" --expect "$E2E_MODEL_REF" --banned "$E2E_BANNED_MODEL" \
    --exempt-agent "$E2E_PIN_EXEMPT_AGENTS" "${own_pins[@]}" --label "$label" "$@" 2>&1)
  status=$?
  if [ "$status" = 0 ]; then
    printf 'PASS  model-pin (%s)\n      %s\n' "$label" "$E2E_AUDIT_LINE" | tee -a "$report"
  else
    printf 'FAIL  model-pin (%s)\n      %s\n' "$label" "$E2E_AUDIT_LINE" | tee -a "$report"
  fi
  return $status
}
