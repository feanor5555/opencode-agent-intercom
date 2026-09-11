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
