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
#                      stays at ~/.cache/opencode-agent-intercom/debug.log,
#                      which every driver slices. A cache is not a setting.
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
#    e2e_model_audit then reads back what answered: every assistant message the
#    run can still see carries `providerID`/`modelID`, and a model other than
#    the pinned one fails the run.
#
# State the functions set:
#
#   E2E_MODEL_REF / E2E_MODEL_PROVIDER / E2E_MODEL_ID   the resolved pin
#   E2E_ISO_HOME              the temporary HOME, removed by e2e_iso_remove
#   E2E_ISO_CONFIG_HOME       $E2E_ISO_HOME/.config, exported
#   E2E_ISO_OPENCODE_DIR      its opencode/ directory
#   E2E_ISO_SETTINGS_FILE     the isolated agent-intercom.json
#   E2E_ISO_MODELS_FILE       the isolated llm-models.json
#   E2E_SERVER_ENV            the assignments e2e_server_start puts in front of
#                             the server process
#
# Requires: python3, curl, cp, mktemp.

# The model every driver runs on unless E2E_MODEL names another. Luna, as
# configured on this machine: provider `cliproxy`, model `gpt-5.6-luna`
# (~/.config/opencode/opencode.json, "Luna (gpt-5.6-luna)").
E2E_DEFAULT_MODEL="cliproxy/gpt-5.6-luna"

# The model no run may use, whatever the rest of the machine is configured
# with. Named here so the refusal reads as itself in a driver's output.
E2E_BANNED_MODEL="gpuserver/Qwen3.8 Flash Next"

# Every agent name the pin is written for: the ten roles this plugin installs
# (src/agents.js AGENTS) plus the opencode built-ins that can answer a turn of
# their own. `applyModelChoices` only touches names that are already in
# `config.agent`, so a name no build knows costs nothing.
E2E_PINNED_AGENTS="orchestrator planner coder debugger reviewer documenter researcher grounder designer gitter build plan general title summary compaction"

# The keys carried over from the machine's agent-intercom.json into the
# isolated one: the search endpoint and credentials a run needs to reach the
# web, and nothing that decides behaviour under test.
E2E_CARRIED_SETTINGS="searxngUrl exaApiKey forumBangs"

E2E_MODEL_REF=""
E2E_MODEL_PROVIDER=""
E2E_MODEL_ID=""
E2E_ISO_HOME=""
E2E_ISO_CONFIG_HOME=""
E2E_ISO_OPENCODE_DIR=""
E2E_ISO_SETTINGS_FILE=""
E2E_ISO_MODELS_FILE=""
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

# The plugin's debug log of the run: the cache is shared with the machine, so
# this is the path it has always been.
e2e_debug_log() {
  printf '%s/.cache/opencode-agent-intercom/debug.log' "${HOME:-}"
}

# ---------- the model pin --------------------------------------------------

# Resolves E2E_MODEL into E2E_MODEL_REF/PROVIDER/ID and refuses the banned
# model outright, before anything is started. Exports E2E_MODEL so a driver
# this one sequences resolves the same pin.
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
  E2E_MODEL="$ref"
  export E2E_MODEL
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

  # auth.json and opencode.db, and the plugin's own cache: shared with the
  # machine on purpose — see the header.
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
      "$E2E_PINNED_AGENTS" "$E2E_CARRIED_SETTINGS" "$settings_json" <<'PY' || {
import json, os, sys

machine, iso, plugin_root, provider, model_id, agents, carried, settings_json = sys.argv[1:9]
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
# machine's, not of the run.
write("llm-models.json", {name: {"providerID": provider, "modelID": model_id} for name in agents.split()})

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
  export E2E_ISO_HOME E2E_ISO_CONFIG_HOME E2E_ISO_OPENCODE_DIR E2E_ISO_SETTINGS_FILE E2E_ISO_MODELS_FILE

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

  e2e_say "isolated config: $iso_dir (model pin $E2E_MODEL_REF, every agent; the machine's ~/.config/opencode is untouched)"
  return 0
}

# Removes the isolated home. The two symlinks inside it are removed as links —
# rm never follows one — so the machine's .cache and .local/share are safe.
# A no-op when no home was created, and idempotent.
e2e_iso_remove() {
  [ -n "${E2E_ISO_HOME:-}" ] || return 0
  case "$E2E_ISO_HOME" in
    /tmp/e2e-opencode-home.*|"${TMPDIR%/}"/e2e-opencode-home.*) : ;;
    *)
      e2e_fail "e2e_iso_remove: refusing to remove $E2E_ISO_HOME — not a home this library created"
      return 1
      ;;
  esac
  rm -rf -- "$E2E_ISO_HOME" && e2e_say "isolated config removed ($E2E_ISO_HOME)"
  E2E_ISO_HOME=""
  E2E_ISO_CONFIG_HOME=""
  E2E_ISO_OPENCODE_DIR=""
  E2E_ISO_SETTINGS_FILE=""
  E2E_ISO_MODELS_FILE=""
  E2E_SERVER_ENV=()
  unset E2E_ISO_HOME E2E_ISO_CONFIG_HOME E2E_ISO_OPENCODE_DIR E2E_ISO_SETTINGS_FILE E2E_ISO_MODELS_FILE
  return 0
}

# ---------- the model audit ------------------------------------------------

# Usage: e2e_audit_fetch_sessions <base_url> <out_prefix> <sid> [sid ...]
#
# Writes each session's message tree to <out_prefix>.audit-<sid>.json, skipping
# a session that no longer answers with a non-empty list — a subagent session is
# deleted the moment it finishes, and a 404 must not overwrite a snapshot taken
# while it was alive. Prints the files it wrote, one per line.
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
# E2E_AUDIT_LINE carries the one-line evidence either way.
E2E_AUDIT_LINE=""
e2e_model_audit() {
  local label="$1" report="$2" status
  shift 2
  local lib
  lib=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib
  E2E_AUDIT_LINE=$(python3 "$lib/model-audit.py" --expect "$E2E_MODEL_REF" --banned "$E2E_BANNED_MODEL" --label "$label" "$@" 2>&1)
  status=$?
  if [ "$status" = 0 ]; then
    printf 'PASS  model-pin (%s)\n      %s\n' "$label" "$E2E_AUDIT_LINE" | tee -a "$report"
  else
    printf 'FAIL  model-pin (%s)\n      %s\n' "$label" "$E2E_AUDIT_LINE" | tee -a "$report"
  fi
  return $status
}
