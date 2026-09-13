// Unit tests for test/e2e/config-isolation.sh and test/e2e/lib/model-audit.py —
// the throwaway opencode configuration an end-to-end run is carried out in, and
// the audit of what actually answered.
//
// Nothing here starts a server or calls a model: the library is sourced into a
// throwaway bash script, pointed at a fake machine config through
// E2E_MACHINE_CONFIG_HOME, and the files it writes are read back.
//
// Run: node --test test/

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, lstatSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const LIB = resolve(import.meta.dirname, "e2e/config-isolation.sh")
const AUDIT = resolve(import.meta.dirname, "e2e/lib/model-audit.py")
const PLUGIN_ROOT = resolve(import.meta.dirname, "..")

// A machine config directory the library may read but must never write.
function machineConfig(dir, extra = {}) {
  const cfg = join(dir, "machine", "opencode")
  mkdirSync(cfg, { recursive: true })
  writeFileSync(
    join(cfg, "opencode.json"),
    JSON.stringify({
      plugin: ["/somewhere/else"],
      provider: { openai: { npm: "@ai-sdk/openai-compatible", models: { "gpt-5.6-luna": {} } } },
      model: "gpuserver/Qwen3.8 Flash Next",
      agent: { coder: { model: "gpuserver/Qwen3.8 Flash Next", variant: "xhigh" } },
      ...extra.config,
    }),
  )
  writeFileSync(
    join(cfg, "llm-models.json"),
    JSON.stringify({ orchestrator: { providerID: "gpuserver", modelID: "Qwen3.8 Flash Next" } }),
  )
  writeFileSync(
    join(cfg, "agent-intercom.json"),
    JSON.stringify({ searxngUrl: "http://searx.example", exaApiKey: "secret", maxSubagents: 1, endlessMode: true }),
  )
  return cfg
}

function runShell(script, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "iso-test-"))
  const machine = machineConfig(dir)
  const path = join(dir, "script.sh")
  writeFileSync(path, script)
  const r = spawnSync("bash", [path], {
    encoding: "utf8",
    env: {
      ...process.env,
      LIB,
      DIR: dir,
      MACHINE: machine,
      PLUGIN_ROOT,
      E2E_MACHINE_CONFIG_HOME: join(dir, "machine"),
      ...env,
    },
  })
  return { ...r, dir, machine }
}

test("e2e_resolve_model defaults to Luna and refuses the banned model", () => {
  const r = runShell(`
. "$LIB"
e2e_resolve_model && echo "DEFAULT=$E2E_MODEL_REF/$E2E_MODEL_PROVIDER/$E2E_MODEL_ID"
E2E_MODEL="gpuserver/Qwen3.8 Flash Next" e2e_resolve_model && echo BANNED_ACCEPTED || echo BANNED_REFUSED
E2E_MODEL="nothingusable" e2e_resolve_model && echo PAIR_ACCEPTED || echo PAIR_REFUSED
E2E_MODEL="xai/grok-4.6" e2e_resolve_model && echo "OVERRIDE=$E2E_MODEL_REF"
`)
  assert.match(r.stdout, /DEFAULT=openai\/gpt-5\.6-luna\/openai\/gpt-5\.6-luna/)
  assert.match(r.stdout, /BANNED_REFUSED/)
  assert.match(r.stderr, /no end-to-end run may use that model/)
  assert.match(r.stdout, /PAIR_REFUSED/)
  assert.match(r.stdout, /OVERRIDE=xai\/grok-4\.6/)
  rmSync(r.dir, { recursive: true, force: true })
})

test("e2e_iso_create pins every agent, wires the plugin and leaves the machine config untouched", () => {
  const r = runShell(`
set -e
. "$LIB"
e2e_resolve_model
e2e_iso_create "$PLUGIN_ROOT" '{"maxSubagents":8,"endlessMode":false}'
echo "ISO=$E2E_ISO_OPENCODE_DIR"
echo "ENV=\${E2E_SERVER_ENV[*]}"
`)
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  const iso = /ISO=(.*)/.exec(r.stdout)[1]

  const models = JSON.parse(readFileSync(join(iso, "llm-models.json"), "utf8"))
  for (const name of ["orchestrator", "planner", "coder", "researcher", "grounder", "gitter", "title", "summary"]) {
    assert.deepEqual(models[name], { providerID: "openai", modelID: "gpt-5.6-luna" }, `${name} is not pinned`)
  }
  // A reasoning effort is a setting of the machine's, not of the run.
  for (const entry of Object.values(models)) assert.ok(!("variant" in entry))

  const config = JSON.parse(readFileSync(join(iso, "opencode.json"), "utf8"))
  assert.deepEqual(config.plugin, [PLUGIN_ROOT], "the plugin under test has to be the wired one")
  assert.equal(config.model, "openai/gpt-5.6-luna")
  assert.equal(config.small_model, "openai/gpt-5.6-luna")
  assert.ok(config.provider.openai, "the machine's providers have to be carried over")
  assert.ok(!("model" in config.agent.coder), "a per-agent model of the machine's must not survive")
  assert.ok(!("variant" in config.agent.coder))

  const tui = JSON.parse(readFileSync(join(iso, "tui.json"), "utf8"))
  assert.deepEqual(tui.plugin, [PLUGIN_ROOT])

  // The driver's own settings win; the credential keys are carried over.
  const settings = JSON.parse(readFileSync(join(iso, "agent-intercom.json"), "utf8"))
  assert.equal(settings.maxSubagents, 8)
  assert.equal(settings.endlessMode, false)
  assert.equal(settings.searxngUrl, "http://searx.example")
  assert.equal(settings.exaApiKey, "secret")

  // The env the server is started with.
  const env = /ENV=(.*)/.exec(r.stdout)[1]
  const home = iso.replace(/\/\.config\/opencode$/, "")
  assert.ok(env.includes(`HOME=${home}`), env)
  assert.ok(env.includes(`XDG_CONFIG_HOME=${home}/.config`), env)
  assert.ok(env.includes(`XDG_STATE_HOME=${home}/.local/state`), env)
  // opencode's own state is NOT shared: the variant store must not be rewritten.
  assert.ok(!lstatSync(join(home, ".local/state")).isSymbolicLink())
  // auth and the plugin's cache are.
  assert.ok(lstatSync(join(home, ".local/share")).isSymbolicLink())
  assert.ok(lstatSync(join(home, ".cache")).isSymbolicLink())

  // Nothing of the machine's was touched.
  const machineModels = JSON.parse(readFileSync(join(r.machine, "llm-models.json"), "utf8"))
  assert.deepEqual(machineModels.orchestrator, { providerID: "gpuserver", modelID: "Qwen3.8 Flash Next" })
  const machineSettings = JSON.parse(readFileSync(join(r.machine, "agent-intercom.json"), "utf8"))
  assert.equal(machineSettings.maxSubagents, 1)

  rmSync(home, { recursive: true, force: true })
  rmSync(r.dir, { recursive: true, force: true })
})

test("e2e_iso_remove takes the home and leaves the linked directories alone", () => {
  const r = runShell(`
set -e
. "$LIB"
e2e_resolve_model
e2e_iso_create "$PLUGIN_ROOT" '{}'
HOME_WAS="$E2E_ISO_HOME"
echo "HOME_WAS=$HOME_WAS"
e2e_iso_remove
[ -e "$HOME_WAS" ] && echo STILL_THERE || echo GONE
[ -d "$HOME/.cache" ] && echo CACHE_INTACT || echo CACHE_LOST
[ -d "$HOME/.local/share" ] && echo SHARE_INTACT || echo SHARE_LOST
echo "AFTER=\${E2E_ISO_CONFIG_HOME:-unset}"
`)
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /GONE/)
  assert.match(r.stdout, /CACHE_INTACT/)
  assert.match(r.stdout, /SHARE_INTACT/)
  assert.match(r.stdout, /AFTER=unset/)
  rmSync(r.dir, { recursive: true, force: true })
})

test("e2e_iso_create refuses a home it did not create", () => {
  const r = runShell(`
. "$LIB"
E2E_ISO_HOME="$DIR/not-ours"
mkdir -p "$E2E_ISO_HOME"
e2e_iso_remove && echo REMOVED || echo REFUSED
[ -d "$DIR/not-ours" ] && echo INTACT
`)
  assert.match(r.stdout, /REFUSED/)
  assert.match(r.stdout, /INTACT/)
  rmSync(r.dir, { recursive: true, force: true })
})

// ---------- the audit ------------------------------------------------------

function capture(dir, name, models) {
  const path = join(dir, name)
  writeFileSync(
    path,
    JSON.stringify(
      models.map(([providerID, modelID], i) => ({
        info: {
          id: `msg_${i}`,
          role: "assistant",
          sessionID: "ses_1",
          mode: "orchestrator",
          providerID,
          modelID,
        },
        parts: [],
      })),
    ),
  )
  return path
}

function audit(files, expect = "openai/gpt-5.6-luna") {
  return spawnSync(
    "python3",
    [AUDIT, "--expect", expect, "--banned", "gpuserver/Qwen3.8 Flash Next", "--label", "t", ...files],
    { encoding: "utf8" },
  )
}

test("the model audit passes only when every assistant message names the pin", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"))
  const good = capture(dir, "good.json", [
    ["openai", "gpt-5.6-luna"],
    ["openai", "gpt-5.6-luna"],
  ])
  const r = audit([good])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /2 assistant message\(s\) over 1 capture\(s\)/)
  assert.match(r.stdout, /every one answered by openai\/gpt-5\.6-luna=2/)
  rmSync(dir, { recursive: true, force: true })
})

test("the model audit fails on a foreign model and names the banned one as such", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"))
  const mixed = capture(dir, "mixed.json", [
    ["openai", "gpt-5.6-luna"],
    ["gpuserver", "Qwen3.8 Flash Next"],
    ["xai", "grok-4.6"],
  ])
  const r = audit([mixed])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /1 of them on the banned gpuserver\/Qwen3\.8 Flash Next/)
  assert.match(r.stdout, /turn on gpuserver\/Qwen3\.8 Flash Next — agent orchestrator, session ses_1/)
  assert.match(r.stdout, /turn on xai\/grok-4\.6/)
  rmSync(dir, { recursive: true, force: true })
})

test("the model audit fails rather than passes when there is nothing to audit", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"))
  const empty = join(dir, "empty.json")
  writeFileSync(empty, "[]")
  const r = audit([empty, join(dir, "never-written.json")])
  assert.equal(r.status, 2, r.stdout)
  assert.match(r.stdout, /nothing to audit/)
  rmSync(dir, { recursive: true, force: true })
})

test("e2e_model_audit reports PASS/FAIL into the report and returns the status", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"))
  capture(dir, "cap.json", [["gpuserver", "Qwen3.8 Flash Next"]])
  const script = join(dir, "run.sh")
  writeFileSync(
    script,
    `. "${LIB}"
e2e_resolve_model
e2e_model_audit "13-message" "${dir}/report.txt" "${dir}/cap.json" && echo AUDIT_OK || echo "AUDIT_FAILED=$?"
`,
  )
  const r = spawnSync("bash", [script], { encoding: "utf8" })
  assert.match(r.stdout, /FAIL {2}model-pin \(13-message\)/)
  assert.match(r.stdout, /AUDIT_FAILED=1/)
  assert.match(readFileSync(join(dir, "report.txt"), "utf8"), /FAIL {2}model-pin/)
  rmSync(dir, { recursive: true, force: true })
})

// The out directory is shared and never emptied: it holds the captures of every
// earlier run as well, on whatever model those runs pinned. An audit that globs
// it reports those turns as foreign models of the present run.
test("the audit reads the captures this run recorded and no other file beside them", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"))
  capture(dir, "mine.json", [["openai", "gpt-5.6-luna"]])
  capture(dir, "subshell.json", [["openai", "gpt-5.6-luna"]])
  // What an earlier run left in the same directory, on the model it pinned.
  capture(dir, "stale.json", [
    ["xai", "grok-4.6"],
    ["xai", "grok-4.6"],
  ])
  const script = join(dir, "run.sh")
  writeFileSync(
    script,
    `. "${LIB}"
e2e_resolve_model
e2e_audit_record "${dir}/mine.json"
e2e_audit_record "${dir}/mine.json"
# A capture taken inside a command substitution: the subshell cannot write the
# parent's variables, and the record has to survive it all the same.
TAKEN=$(e2e_audit_record "${dir}/subshell.json"; printf taken)
echo "TAKEN=$TAKEN"
e2e_audit_recorded "11-endless" "${dir}/report.txt" && echo AUDIT_OK || echo "AUDIT_FAILED=$?"
`,
  )
  const r = spawnSync("bash", [script], { encoding: "utf8" })
  assert.match(r.stdout, /TAKEN=taken/)
  assert.match(r.stdout, /AUDIT_OK/, r.stdout + r.stderr)
  assert.match(r.stdout, /2 assistant message\(s\) over 2 capture\(s\)/)
  assert.match(r.stdout, /every one answered by openai\/gpt-5\.6-luna=2/)
  assert.doesNotMatch(r.stdout, /grok/)
  rmSync(dir, { recursive: true, force: true })
})

test("the audit fails rather than passes when the run recorded no capture", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"))
  capture(dir, "stale.json", [["xai", "grok-4.6"]])
  const script = join(dir, "run.sh")
  writeFileSync(
    script,
    `. "${LIB}"
e2e_resolve_model
e2e_audit_recorded "11-endless" "${dir}/report.txt" && echo AUDIT_OK || echo "AUDIT_FAILED=$?"
`,
  )
  const r = spawnSync("bash", [script], { encoding: "utf8" })
  assert.match(r.stdout, /AUDIT_FAILED=2/)
  assert.match(r.stdout, /no capture of this run was recorded/)
  assert.match(readFileSync(join(dir, "report.txt"), "utf8"), /FAIL {2}model-pin/)
  rmSync(dir, { recursive: true, force: true })
})

// ---------- the capture manifest is keyed on the driver invocation ---------

// run-all.sh sequences eight run-task.sh invocations and four further drivers
// against one out directory. Each of them audits over the captures IT recorded,
// so the list one appends to may not be the list the next one reads: a capture
// of an earlier driver — taken under another E2E_MODEL in an out directory that
// is never emptied — would otherwise fail the later driver's audit.
test("each driver invocation audits its own captures and no earlier invocation's", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"))
  // What an earlier driver of the same run left behind, on the model it pinned.
  capture(dir, "first.json", [["xai", "grok-4.6"]])
  capture(dir, "second.json", [["openai", "gpt-5.6-luna"]])

  const child = join(dir, "child.sh")
  writeFileSync(
    child,
    `. "${LIB}"
e2e_resolve_model
echo "MANIFEST_$TAG=$E2E_AUDIT_MANIFEST"
e2e_audit_record "$CAP"
e2e_audit_recorded "$TAG" /dev/null > /dev/null && echo "OK_$TAG" || echo "FAILED_$TAG=$?"
echo "LINE_$TAG=$E2E_AUDIT_LINE"
`,
  )
  // The sequencing driver sources the library too, and exports what it holds:
  // neither its own manifest nor its pid may reach the drivers it invokes.
  const parent = join(dir, "parent.sh")
  writeFileSync(
    parent,
    `. "${LIB}"
export E2E_AUDIT_MANIFEST E2E_AUDIT_OWNER
echo "MANIFEST_parent=$E2E_AUDIT_MANIFEST"
TAG=first CAP="${dir}/first.json" bash "${child}"
TAG=second CAP="${dir}/second.json" bash "${child}"
`,
  )
  const r = spawnSync("bash", [parent], { encoding: "utf8", env: { ...process.env, TMPDIR: dir } })

  const paths = [...r.stdout.matchAll(/^MANIFEST_\w+=(.+)$/gm)].map((m) => m[1])
  assert.equal(paths.length, 3, r.stdout)
  assert.equal(new Set(paths).size, 3, `three invocations, ${new Set(paths).size} manifest(s): ${paths.join(" ")}`)

  // The first driver ran on a foreign model and fails on its own capture.
  assert.match(r.stdout, /FAILED_first=1/, r.stdout + r.stderr)
  // The second sees only what it recorded itself — not the first driver's turn.
  assert.match(r.stdout, /OK_second/, r.stdout + r.stderr)
  assert.match(r.stdout, /LINE_second=.*1 assistant message\(s\) over 1 capture\(s\)/)
  assert.doesNotMatch(/LINE_second=.*/.exec(r.stdout)[0], /grok/)

  rmSync(dir, { recursive: true, force: true })
})

// message-task.sh and ask-task.sh reach the library through lib/midrun-common.sh;
// a driver that also sources it directly sources it twice in the one process.
test("sourcing the library again in the same process keeps the captures already recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"))
  capture(dir, "early.json", [["openai", "gpt-5.6-luna"]])
  capture(dir, "late.json", [["openai", "gpt-5.6-luna"]])
  const script = join(dir, "run.sh")
  writeFileSync(
    script,
    `. "${LIB}"
e2e_resolve_model
FIRST="$E2E_AUDIT_MANIFEST"
e2e_audit_record "${dir}/early.json"
. "${LIB}"
e2e_resolve_model
[ "$E2E_AUDIT_MANIFEST" = "$FIRST" ] && echo SAME_MANIFEST || echo REKEYED
e2e_audit_record "${dir}/late.json"
e2e_audit_recorded "13-message" /dev/null > /dev/null && echo AUDIT_OK || echo "AUDIT_FAILED=$?"
echo "LINE=$E2E_AUDIT_LINE"
`,
  )
  const r = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, TMPDIR: dir } })
  assert.match(r.stdout, /SAME_MANIFEST/, r.stdout + r.stderr)
  assert.match(r.stdout, /AUDIT_OK/, r.stdout + r.stderr)
  assert.match(r.stdout, /2 assistant message\(s\) over 2 capture\(s\)/)
  rmSync(dir, { recursive: true, force: true })
})

// The pin is kept across that second source the same way the manifest is, so a
// driver resolves the model once and not after every source of the library.
test("sourcing the library again in the same process keeps the pin already resolved", () => {
  const r = runShell(`
set -e
. "$LIB"
export E2E_MODEL="xai/grok-4.6"
e2e_resolve_model
. "$LIB"
echo "REF=$E2E_MODEL_REF PROVIDER=$E2E_MODEL_PROVIDER ID=$E2E_MODEL_ID"
e2e_iso_create "$PLUGIN_ROOT" '{"maxSubagents":1}'
echo "ISO=$E2E_ISO_OPENCODE_DIR"
`)
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /REF=xai\/grok-4\.6 PROVIDER=xai ID=grok-4\.6/, r.stdout + r.stderr)
  // The pin that survived is the one the isolated config is then built around.
  const iso = /ISO=(.*)/.exec(r.stdout)[1]
  const models = JSON.parse(readFileSync(join(iso, "llm-models.json"), "utf8"))
  assert.deepEqual(models.orchestrator, { providerID: "xai", modelID: "grok-4.6" })
  rmSync(r.dir, { recursive: true, force: true })
})

// The keying is on the process, as the manifest's is: a pin reaching a driver
// from outside has not been through the banned-model refusal, so it is dropped
// rather than adopted. E2E_MODEL, which every driver does resolve from, is the
// one way a pin travels between processes.
test("a pin from another process is not adopted by a source of the library", () => {
  const r = runShell(
    `
. "$LIB"
echo "REF=[$E2E_MODEL_REF] PROVIDER=[$E2E_MODEL_PROVIDER] ID=[$E2E_MODEL_ID]"
e2e_iso_create "$PLUGIN_ROOT" '{"maxSubagents":1}' && echo CREATED || echo REFUSED
`,
    {
      E2E_MODEL_REF: "gpuserver/Qwen3.8 Flash Next",
      E2E_MODEL_PROVIDER: "gpuserver",
      E2E_MODEL_ID: "Qwen3.8 Flash Next",
      E2E_MODEL_OWNER: String(process.pid),
    },
  )
  assert.match(r.stdout, /REF=\[\] PROVIDER=\[\] ID=\[\]/, r.stdout + r.stderr)
  assert.match(r.stdout, /REFUSED/, r.stdout + r.stderr)
  assert.match(r.stderr, /call e2e_resolve_model first/)
  rmSync(r.dir, { recursive: true, force: true })
})

// ---------- the isolated set travels to the drivers a driver invokes -------

// run-all.sh builds the isolated home and exports the E2E_ISO_* set; the
// drivers it sequences build none of their own and have to read THAT
// configuration. message-task.sh and ask-task.sh resolve the settings file they
// refuse a run over through e2e_opencode_config_dir (lib/midrun-common.sh), so a
// child that blanked the inherited set would read the machine's
// agent-intercom.json while the server runs on the isolated one.
test("a driver invoked by another reads the isolated configuration, not the machine's", () => {
  const r = runShell(
    `
set -e
. "$LIB"
e2e_resolve_model
e2e_iso_create "$PLUGIN_ROOT" '{"maxSubagents":8}' > /dev/null
echo "PARENT_DIR=$(e2e_opencode_config_dir)"
cat > "$DIR/child.sh" <<'CHILD'
. "$LIB"
echo "CHILD_DIR=$(e2e_opencode_config_dir)"
echo "CHILD_SETTINGS=$E2E_ISO_SETTINGS_FILE"
echo "CHILD_MODELS=$E2E_ISO_MODELS_FILE"
echo "CHILD_PIN=[$E2E_MODEL_REF]"
CHILD
bash "$DIR/child.sh"
echo "HOME_WAS=$E2E_ISO_HOME"
e2e_iso_remove > /dev/null
`,
    // Only the fallback of e2e_opencode_config_dir reads this; the machine
    // config the library copies from is E2E_MACHINE_CONFIG_HOME.
    { XDG_CONFIG_HOME: "/nowhere/machine" },
  )
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  const parentDir = /PARENT_DIR=(.*)/.exec(r.stdout)[1]
  const childDir = /CHILD_DIR=(.*)/.exec(r.stdout)[1]
  assert.equal(childDir, parentDir, "the child resolved another config directory than the one in force")
  assert.doesNotMatch(childDir, /nowhere\/machine/, `the child fell back to the machine's config: ${childDir}`)
  assert.equal(/CHILD_SETTINGS=(.*)/.exec(r.stdout)[1], join(parentDir, "agent-intercom.json"))
  assert.equal(/CHILD_MODELS=(.*)/.exec(r.stdout)[1], join(parentDir, "llm-models.json"))
  // The pin's own rule is untouched by this: it is keyed on $$ and stays
  // unadopted across a process boundary, because a model reference from outside
  // has not been through the banned-model refusal.
  assert.match(r.stdout, /CHILD_PIN=\[\]/, r.stdout)
  rmSync(/HOME_WAS=(.*)/.exec(r.stdout)[1], { recursive: true, force: true })
  rmSync(r.dir, { recursive: true, force: true })
})

// The marker for "already built" is the isolated opencode directory itself: a
// set left in the environment by a run whose home is long gone names nothing
// and is dropped, so the fallback is reached rather than a path that is not
// there.
test("an inherited E2E_ISO_* set whose directory is gone is dropped", () => {
  const r = runShell(
    `
. "$LIB"
echo "DIR=$(e2e_opencode_config_dir)"
echo "HOME_VAR=[$E2E_ISO_HOME] SETTINGS=[$E2E_ISO_SETTINGS_FILE]"
`,
    {
      E2E_ISO_HOME: "/tmp/e2e-opencode-home.gone",
      E2E_ISO_CONFIG_HOME: "/tmp/e2e-opencode-home.gone/.config",
      E2E_ISO_OPENCODE_DIR: "/tmp/e2e-opencode-home.gone/.config/opencode",
      E2E_ISO_SETTINGS_FILE: "/tmp/e2e-opencode-home.gone/.config/opencode/agent-intercom.json",
      E2E_ISO_MODELS_FILE: "/tmp/e2e-opencode-home.gone/.config/opencode/llm-models.json",
      XDG_CONFIG_HOME: "/nowhere/machine",
    },
  )
  assert.match(r.stdout, /DIR=\/nowhere\/machine\/opencode/, r.stdout)
  assert.match(r.stdout, /HOME_VAR=\[\] SETTINGS=\[\]/, r.stdout)
  rmSync(r.dir, { recursive: true, force: true })
})

// The paths travel, the claim to remove them does not. endless-task.sh and
// nested-task.sh install their cleanup trap BEFORE building a home of their
// own, so an early exit of a driver that run-all.sh invoked would otherwise
// take the caller's live configuration with it.
test("a driver that inherited the set does not remove the home its caller built", () => {
  const r = runShell(`
set -e
. "$LIB"
e2e_resolve_model
e2e_iso_create "$PLUGIN_ROOT" '{}' > /dev/null
HOME_WAS="$E2E_ISO_HOME"
echo "HOME_WAS=$HOME_WAS"
cat > "$DIR/child.sh" <<'CHILD'
. "$LIB"
e2e_iso_remove && echo CHILD_REMOVE_OK || echo "CHILD_REMOVE_FAILED=$?"
CHILD
bash "$DIR/child.sh"
[ -d "$HOME_WAS/.config/opencode" ] && echo STILL_THERE || echo GONE_TOO_EARLY
e2e_iso_remove > /dev/null
[ -e "$HOME_WAS" ] && echo OWNER_KEPT || echo OWNER_REMOVED
`)
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
  assert.match(r.stdout, /CHILD_REMOVE_OK/, r.stdout + r.stderr)
  assert.match(r.stdout, /isolated config kept/, "the child said nothing about leaving the home standing")
  assert.match(r.stdout, /STILL_THERE/, r.stdout)
  // The process that built it still removes it.
  assert.match(r.stdout, /OWNER_REMOVED/, r.stdout)
  rmSync(/HOME_WAS=(.*)/.exec(r.stdout)[1], { recursive: true, force: true })
  rmSync(r.dir, { recursive: true, force: true })
})

// TMPDIR survives a run. A manifest an earlier run left there — including one
// under the pid-keyed name runs before this keying wrote — must never be read:
// it names captures of that run, on the model that run pinned.
test("a manifest an earlier run left in TMPDIR is not the one this invocation reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-test-"))
  capture(dir, "stale.json", [["xai", "grok-4.6"]])
  capture(dir, "mine.json", [["openai", "gpt-5.6-luna"]])
  const script = join(dir, "run.sh")
  writeFileSync(
    script,
    `STALE="$TMPDIR/e2e-audit-captures.$$.list"
printf '%s\\n' "${dir}/stale.json" > "$STALE"
chmod 444 "$STALE"
. "${LIB}"
e2e_resolve_model
echo "MANIFEST=$E2E_AUDIT_MANIFEST"
e2e_audit_record "${dir}/mine.json"
e2e_audit_recorded "02-planner" /dev/null > /dev/null && echo AUDIT_OK || echo "AUDIT_FAILED=$?"
echo "LINE=$E2E_AUDIT_LINE"
printf 'STALE_INTACT=%s\\n' "$(cat "$STALE")"
`,
  )
  const r = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, TMPDIR: dir } })
  const manifest = /^MANIFEST=(.+)$/m.exec(r.stdout)[1]
  assert.doesNotMatch(manifest, /\.list$/, `the invocation took the stale pid-keyed name: ${manifest}`)
  assert.match(r.stdout, /AUDIT_OK/, r.stdout + r.stderr)
  assert.match(r.stdout, /1 assistant message\(s\) over 1 capture\(s\)/)
  assert.doesNotMatch(r.stdout, /grok/)
  assert.match(r.stdout, /STALE_INTACT=.*stale\.json/)
  rmSync(dir, { recursive: true, force: true })
})

// ---------- the drivers ----------------------------------------------------

test("every driver resolves its model through the library and none carries an own default", () => {
  const e2e = resolve(import.meta.dirname, "e2e")
  for (const name of [
    "run-all.sh",
    "run-task.sh",
    "multi-task.sh",
    "endless-task.sh",
    "nested-task.sh",
    "lib/midrun-common.sh",
  ]) {
    const src = readFileSync(join(e2e, name), "utf8")
    assert.match(src, /\be2e_resolve_model\b/, `${name} does not resolve the model through the library`)
    assert.doesNotMatch(src, /E2E_MODEL:-/, `${name} still carries a model default of its own`)
  }
})

test("no driver reads or writes the machine's opencode configuration", () => {
  const e2e = resolve(import.meta.dirname, "e2e")
  for (const name of [
    "run-all.sh",
    "run-task.sh",
    "multi-task.sh",
    "endless-task.sh",
    "nested-task.sh",
    "ask-task.sh",
    "message-task.sh",
    "lib/midrun-common.sh",
  ]) {
    const src = readFileSync(join(e2e, name), "utf8")
    for (const line of src.split("\n")) {
      if (/^\s*#/.test(line)) continue
      assert.doesNotMatch(
        line,
        /\$HOME\/\.config\/opencode/,
        `${name} resolves a machine config path: ${line}`,
      )
    }
  }
})

test("every driver that owns a server builds and removes an isolated configuration", () => {
  const e2e = resolve(import.meta.dirname, "e2e")
  for (const name of ["run-all.sh", "endless-task.sh", "nested-task.sh"]) {
    const src = readFileSync(join(e2e, name), "utf8")
    assert.match(src, /\be2e_iso_create\b/, `${name} starts a server on no isolated configuration`)
    assert.match(src, /\be2e_iso_remove\b/, `${name} never removes its isolated configuration`)
  }
})

test("every driver audits the model it ran on", () => {
  const e2e = resolve(import.meta.dirname, "e2e")
  for (const name of ["run-task.sh", "multi-task.sh", "endless-task.sh", "nested-task.sh"]) {
    const src = readFileSync(join(e2e, name), "utf8")
    assert.match(src, /\be2e_audit_recorded\b/, `${name} does not audit what answered`)
  }
  for (const name of ["ask-task.sh", "message-task.sh"]) {
    const src = readFileSync(join(e2e, name), "utf8")
    assert.match(src, /\bmr_model_audit\b/, `${name} does not audit what answered`)
  }
  const midrun = readFileSync(join(e2e, "lib/midrun-common.sh"), "utf8")
  assert.match(midrun, /\be2e_audit_recorded\b/, "midrun-common.sh does not audit what answered")
})

// The audit is over the captures the run recorded, never over a pattern matched
// against the out directory: that directory is shared and never emptied, so a
// glob sweeps in the captures of earlier runs and reports the models they were
// pinned to as foreign models of this one.
test("no driver hands the audit a pattern instead of the captures it recorded", () => {
  const e2e = resolve(import.meta.dirname, "e2e")
  for (const name of [
    "run-task.sh",
    "multi-task.sh",
    "endless-task.sh",
    "nested-task.sh",
    "ask-task.sh",
    "message-task.sh",
    "lib/midrun-common.sh",
  ]) {
    const src = readFileSync(join(e2e, name), "utf8")
    for (const line of src.split("\n")) {
      if (/^\s*#/.test(line)) continue
      assert.doesNotMatch(
        line,
        /\be2e_model_audit\b/,
        `${name} audits directly instead of over its recorded captures: ${line}`,
      )
    }
  }
})

// Each capture a driver writes has to be recorded where it is written, or the
// audit passes over a turn nobody looked at.
test("every driver records the captures it writes", () => {
  const e2e = resolve(import.meta.dirname, "e2e")
  for (const name of [
    "run-task.sh",
    "multi-task.sh",
    "endless-task.sh",
    "nested-task.sh",
    "lib/midrun-common.sh",
  ]) {
    const src = readFileSync(join(e2e, name), "utf8")
    assert.match(src, /\be2e_audit_record\b/, `${name} writes captures it never records`)
  }
})

test("every e2e shell file parses", () => {
  const e2e = resolve(import.meta.dirname, "e2e")
  for (const name of [
    "config-isolation.sh",
    "run-all.sh",
    "run-task.sh",
    "multi-task.sh",
    "endless-task.sh",
    "nested-task.sh",
    "ask-task.sh",
    "message-task.sh",
    "lib/midrun-common.sh",
  ]) {
    const r = spawnSync("bash", ["-n", join(e2e, name)], { encoding: "utf8" })
    assert.equal(r.status, 0, `bash -n ${name}: ${r.stderr}`)
    assert.ok(existsSync(join(e2e, name)))
  }
})
