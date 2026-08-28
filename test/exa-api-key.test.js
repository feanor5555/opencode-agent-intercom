// Unit tests for the Exa API key setting.
//
// Resolution order, identical to `searxngUrl`:
//   JSON config file key `exaApiKey` > env EXA_API_KEY > "" (unset).
// "" is a valid state, not an error: web_search then uses Exa's anonymous
// tier and sends no `x-api-key` header at all.
//
// Run: node --test test/exa-api-key.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

import { getExaApiKey, getSettings, setSettingsPath, resetSettings } from "../src/settings.js"
import { exaHeaders } from "../src/websearch.js"

const ENV_NAME = "EXA_API_KEY"

// Placeholders only — never a real key in the repository.
const ENV_KEY = "env-placeholder-not-a-real-key"
const FILE_KEY = "file-placeholder-not-a-real-key"

// Point settings.js at a fresh empty temp file and clear the env, so neither
// the developer's shell nor a previous case leaks into the assertions.
function isolate() {
  const dir = mkdtempSync(join(tmpdir(), "agent-intercom-exa-"))
  const file = join(dir, "agent-intercom.json")
  setSettingsPath(file)
  delete process.env[ENV_NAME]
  resetSettings()
  return { dir, file }
}

const savedEnv = process.env[ENV_NAME]
test.after(() => {
  if (savedEnv === undefined) delete process.env[ENV_NAME]
  else process.env[ENV_NAME] = savedEnv
  resetSettings()
})

test("neither file nor env: key is empty and no x-api-key header is sent", () => {
  const { dir } = isolate()
  try {
    assert.equal(getExaApiKey(), "", "unset must resolve to the empty string")
    const headers = exaHeaders()
    assert.equal(
      "x-api-key" in headers,
      false,
      "no key configured must send no x-api-key header — the anonymous tier is not an error",
    )
    assert.equal(headers["Content-Type"], "application/json")
    assert.equal(headers.Accept, "application/json, text/event-stream")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("env only: EXA_API_KEY is used and lands in the x-api-key header", () => {
  const { dir } = isolate()
  try {
    process.env[ENV_NAME] = ENV_KEY
    resetSettings()
    assert.equal(getExaApiKey(), ENV_KEY)
    assert.equal(exaHeaders()["x-api-key"], ENV_KEY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("env value is trimmed and a blank env value counts as unset", () => {
  const { dir } = isolate()
  try {
    process.env[ENV_NAME] = `  ${ENV_KEY}  `
    resetSettings()
    assert.equal(getExaApiKey(), ENV_KEY, "surrounding whitespace must be stripped")

    process.env[ENV_NAME] = "   "
    resetSettings()
    assert.equal(getExaApiKey(), "", "a whitespace-only env value must count as unset")
    assert.equal("x-api-key" in exaHeaders(), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("settings file only: exaApiKey from the JSON file is used", () => {
  const { dir, file } = isolate()
  try {
    writeFileSync(file, JSON.stringify({ exaApiKey: FILE_KEY }))
    resetSettings()
    assert.equal(getExaApiKey(), FILE_KEY)
    assert.equal(exaHeaders()["x-api-key"], FILE_KEY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("file wins over env — same precedence as searxngUrl", () => {
  const { dir, file } = isolate()
  try {
    process.env[ENV_NAME] = ENV_KEY
    writeFileSync(file, JSON.stringify({ exaApiKey: ` ${FILE_KEY} ` }))
    resetSettings()
    assert.equal(getExaApiKey(), FILE_KEY, "the settings file overrides the environment")
    assert.equal(exaHeaders()["x-api-key"], FILE_KEY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a blank or non-string file value falls back to the env var", () => {
  const { dir, file } = isolate()
  try {
    process.env[ENV_NAME] = ENV_KEY

    writeFileSync(file, JSON.stringify({ exaApiKey: "   " }))
    resetSettings()
    assert.equal(getExaApiKey(), ENV_KEY, "a blank file value must not shadow the env var")

    writeFileSync(file, JSON.stringify({ exaApiKey: 42 }))
    resetSettings()
    assert.equal(getExaApiKey(), ENV_KEY, "a non-string file value must not shadow the env var")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unreadable settings file leaves the env var in effect", () => {
  const { dir, file } = isolate()
  try {
    process.env[ENV_NAME] = ENV_KEY
    writeFileSync(file, "{ not json")
    resetSettings()
    assert.equal(getExaApiKey(), ENV_KEY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the resolved key never reaches the debug log", () => {
  const { dir, file } = isolate()
  try {
    writeFileSync(file, JSON.stringify({ exaApiKey: FILE_KEY }))
    resetSettings()

    // getSettings() logs the whole resolved object; the key must be masked
    // there while staying available in-process.
    assert.equal(getSettings().exaApiKey, FILE_KEY)

    const logPath = join(homedir(), ".cache", "opencode-agent-intercom", "debug.log")
    if (existsSync(logPath)) {
      const tail = readFileSync(logPath, "utf8").slice(-50000)
      assert.equal(tail.includes(FILE_KEY), false, "the key must never be written to the log")
      assert.match(tail, /"exaApiKey":"<set>"/, "the log records only that a key is in effect")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
