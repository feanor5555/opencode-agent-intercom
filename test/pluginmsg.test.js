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
// The second flag on the part is `synthetic`, which client.js stamps from the
// `showAgentcom` setting: while it is off it keeps the part off the transcript and leaves its
// text in the model's payload. The tests below pin which send is hidden —
// postNotice always follows the setting, promptSession only where the call
// site opts in with `hideable` — and that the marker metadata, the text and
// the detector are the same either way. `ignored`, the inverse flag, is never
// set.
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
import { lastUserGoal } from "../src/handoff.js"
import { setSettingsPath, resetSettings } from "../src/settings.js"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Pinned settings path so postNotice's retry settings come from defaults,
// not a real ~/.config file (same discipline as postNotice-retry.test.js).
let tmpDir
let settingsFile
test.beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-intercom-pluginmsg-"))
  settingsFile = join(tmpDir, "agent-intercom.json")
  setSettingsPath(settingsFile)
  delete process.env.OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM
  resetSettings()
})
test.afterEach(() => {
  delete process.env.OPENCODE_AGENT_INTERCOM_SHOW_AGENTCOM
  resetSettings()
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

// Sets the agentcom visibility switch for the next send; the TTL cache is
// dropped so the value is read from the file.
function showAgentcom(on) {
  writeFileSync(settingsFile, JSON.stringify({ showAgentcom: on }))
  resetSettings()
}

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

test("intercomTextPart: without the option the part carries no synthetic key at all", () => {
  const part = intercomTextPart("hello")
  assert.equal("synthetic" in part, false)
  assert.equal("ignored" in part, false)
  assert.deepEqual(part, intercomTextPart("hello", {}))
})

test("intercomTextPart: { hidden: true } stamps synthetic and changes nothing else", () => {
  const visible = intercomTextPart("hello")
  const hidden = intercomTextPart("hello", { hidden: true })
  assert.equal(hidden.synthetic, true)
  // The inverse flag would take the text out of the model payload instead.
  assert.equal("ignored" in hidden, false)
  assert.equal(hidden.text, visible.text)
  assert.deepEqual(hidden.metadata, visible.metadata)
  assert.equal(hidden.type, "text")
})

test("intercomTextPart: { hidden: false } is byte-identical to the visible part", () => {
  assert.deepEqual(intercomTextPart("hello", { hidden: false }), intercomTextPart("hello"))
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

test("postNotice: with showAgentcom on the posted part has no synthetic key", async () => {
  const client = makeFakeClient()
  await postNotice(client, "ses_parent", "🔔 agent-intercom: notice text")
  const part = client.calls[0].body.parts[0]
  assert.equal("synthetic" in part, false)
})

test("postNotice: with showAgentcom off the posted part carries synthetic: true", async () => {
  showAgentcom(false)
  const client = makeFakeClient()
  await postNotice(client, "ses_parent", "🔔 agent-intercom: notice text")
  const part = client.calls[0].body.parts[0]
  assert.equal(part.synthetic, true)
  assert.equal("ignored" in part, false)
  // The wake still carries its full text to the model, and the marker holds.
  assert.equal(part.text, "🔔 agent-intercom: notice text")
  assert.equal(part.metadata[INTERCOM_MESSAGE_METADATA_KEY], true)
})

test("promptSession: with showAgentcom off a call site that does not opt in stays visible", async () => {
  showAgentcom(false)
  const client = makeFakeClient()
  // The spawn task prompt: it lands in the SUBAGENT's session and is that
  // session's entire instruction.
  await promptSession(client, {
    sessionID: "ses_sub",
    agent: "coder",
    prompt: "task text",
  })
  const part = client.calls[0].body.parts[0]
  assert.equal("synthetic" in part, false)
  assert.equal(part.text, "task text")
})

test("promptSession: with showAgentcom off and hideable: true the part is hidden", async () => {
  showAgentcom(false)
  const client = makeFakeClient()
  await promptSession(client, {
    sessionID: "ses_new",
    agent: "orchestrator",
    prompt: "## Stand / Aktueller Zustand\n\nLetztes Ziel: …",
    hideable: true,
  })
  const part = client.calls[0].body.parts[0]
  assert.equal(part.synthetic, true)
  assert.equal(part.text, "## Stand / Aktueller Zustand\n\nLetztes Ziel: …")
  assert.equal(part.metadata[INTERCOM_MESSAGE_METADATA_KEY], true)
})

test("promptSession: with showAgentcom on even hideable: true stays visible", async () => {
  const client = makeFakeClient()
  await promptSession(client, {
    sessionID: "ses_new",
    agent: "orchestrator",
    prompt: "kickoff",
    hideable: true,
  })
  const part = client.calls[0].body.parts[0]
  assert.equal("synthetic" in part, false)
})

test("a hidden part is still recognised as plugin-generated and skipped by the goal scan", async () => {
  showAgentcom(false)
  const client = makeFakeClient()
  await postNotice(client, "ses_parent", '🔔 agent-intercom: your subagent "x" has finished')
  const part = client.calls[0].body.parts[0]
  assert.equal(part.synthetic, true)
  const notice = { info: { role: "user" }, parts: [part] }
  assert.equal(isPluginGeneratedMessage(notice), true)
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "fix the bug in module X" }] },
    notice,
  ]
  assert.equal(lastUserGoal(messages), "fix the bug in module X")
})
