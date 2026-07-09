// Unit tests for src/pluginmsg.js (plugin-message marking + detection) and
// the send-side wiring in src/client.js: postNotice and promptSession are
// the ONLY two functions in src/ that call session.promptAsync, and both
// must attach the metadata marker to their text part — that single central
// marking point is what lets the handoff's goal scan (lastUserGoal) skip
// plugin-generated messages.
//
// The metadata round-trip itself (promptAsync accepts TextPartInput.metadata,
// persists it verbatim, session.messages returns it, the text still reaches
// the provider request) was verified empirically against opencode 1.17.15 —
// see the scratch notes intercom-wake-notice-fix.
//
// Run: node --test --test-timeout=2000 test/pluginmsg.test.js

import test from "node:test"
import assert from "node:assert/strict"

import {
  INTERCOM_MESSAGE_METADATA_KEY,
  intercomTextPart,
  isPluginGeneratedMessage,
  looksLikePluginMessage,
} from "../src/pluginmsg.js"
import { postNotice, promptSession } from "../src/client.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Pinned settings path so postNotice's retry settings come from defaults,
// not a real ~/.config file (same discipline as postNotice-retry.test.js).
let tmpDir
test.beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-intercom-pluginmsg-"))
  setSettingsPath(join(tmpDir, "agent-intercom.json"))
  resetSettings()
})
test.afterEach(() => {
  resetSettings()
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

function makeFakeClient() {
  const calls = []
  return {
    calls,
    session: {
      promptAsync: async (req) => {
        calls.push(req)
      },
    },
  }
}

// ---------------------------------------------------------------------------
// intercomTextPart / isPluginGeneratedMessage
// ---------------------------------------------------------------------------

test("intercomTextPart: builds a text part carrying the marker metadata", () => {
  const part = intercomTextPart("hello")
  assert.equal(part.type, "text")
  assert.equal(part.text, "hello")
  assert.deepEqual(part.metadata, { [INTERCOM_MESSAGE_METADATA_KEY]: true })
})

test("isPluginGeneratedMessage: detects a session-shaped message built from intercomTextPart", () => {
  const msg = { info: { role: "user" }, parts: [intercomTextPart("🔔 notice")] }
  assert.equal(isPluginGeneratedMessage(msg), true)
})

test("isPluginGeneratedMessage: a plain user message is NOT plugin-generated", () => {
  const msg = { info: { role: "user" }, parts: [{ type: "text", text: "real goal" }] }
  assert.equal(isPluginGeneratedMessage(msg), false)
})

test("isPluginGeneratedMessage: foreign metadata without the marker key does not match", () => {
  const msg = {
    info: { role: "user" },
    parts: [{ type: "text", text: "x", metadata: { someOtherPlugin: true } }],
  }
  assert.equal(isPluginGeneratedMessage(msg), false)
})

test("isPluginGeneratedMessage: marker value must be exactly true", () => {
  const msg = {
    info: { role: "user" },
    parts: [{ type: "text", text: "x", metadata: { [INTERCOM_MESSAGE_METADATA_KEY]: "yes" } }],
  }
  assert.equal(isPluginGeneratedMessage(msg), false)
})

test("isPluginGeneratedMessage: also accepts the chat-completion shape ({role, content})", () => {
  const msg = { role: "user", content: [intercomTextPart("notice")] }
  assert.equal(isPluginGeneratedMessage(msg), true)
})

test("isPluginGeneratedMessage: defensive on malformed input", () => {
  assert.equal(isPluginGeneratedMessage(null), false)
  assert.equal(isPluginGeneratedMessage(undefined), false)
  assert.equal(isPluginGeneratedMessage("string"), false)
  assert.equal(isPluginGeneratedMessage({}), false)
  assert.equal(isPluginGeneratedMessage({ parts: [null, "x", 42] }), false)
})

// ---------------------------------------------------------------------------
// looksLikePluginMessage (legacy/TUI backstop)
// ---------------------------------------------------------------------------

test("looksLikePluginMessage: matches the verbatim leading strings of all plugin message kinds", () => {
  assert.equal(looksLikePluginMessage('🔔 agent-intercom: your subagent "x" has finished'), true)
  assert.equal(looksLikePluginMessage('⚠️ agent-intercom: subagent "x" is OVER its context budget'), true)
  assert.equal(looksLikePluginMessage("## Stand / Aktueller Zustand\n\nLetztes Ziel: x"), true)
  assert.equal(
    looksLikePluginMessage("You are about to be replaced by a fresh orchestrator session. …"),
    true,
  )
})

test("looksLikePluginMessage: tolerates leading whitespace, rejects mid-text occurrences", () => {
  assert.equal(looksLikePluginMessage("  \n🔔 agent-intercom: notice"), true)
  assert.equal(looksLikePluginMessage('why did I get "🔔 agent-intercom: …" twice?'), false)
  assert.equal(looksLikePluginMessage("fix the bug in module X"), false)
  assert.equal(looksLikePluginMessage(""), false)
  assert.equal(looksLikePluginMessage(undefined), false)
})

// ---------------------------------------------------------------------------
// Send-side wiring: client.js marks EVERY outgoing message
// ---------------------------------------------------------------------------

test("postNotice: the transported part carries the marker metadata", async () => {
  const client = makeFakeClient()
  await postNotice(client, "ses_parent", "🔔 agent-intercom: notice text")
  assert.equal(client.calls.length, 1)
  const part = client.calls[0].body.parts[0]
  assert.equal(part.type, "text")
  assert.equal(part.text, "🔔 agent-intercom: notice text")
  assert.equal(part.metadata[INTERCOM_MESSAGE_METADATA_KEY], true)
  // Round-trip through the detector — exactly what lastUserGoal will do.
  assert.equal(isPluginGeneratedMessage({ info: { role: "user" }, parts: [part] }), true)
})

test("promptSession: kickoff/doc-summary/spawn prompts carry the marker metadata", async () => {
  const client = makeFakeClient()
  await promptSession(client, {
    sessionID: "ses_new",
    agent: "orchestrator",
    prompt: "## Stand / Aktueller Zustand\n\nLetztes Ziel: …",
  })
  assert.equal(client.calls.length, 1)
  const { body } = client.calls[0]
  assert.equal(body.agent, "orchestrator")
  const part = body.parts[0]
  assert.equal(part.type, "text")
  assert.equal(part.metadata[INTERCOM_MESSAGE_METADATA_KEY], true)
})
