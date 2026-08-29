// The agent a replacement primary is created under (src/handoffwiring.js).
//
// The handoff used to hard-code "orchestrator", so a project whose primary is
// called something else was replaced by an agent it never selected. The name
// now comes from the identification chain's own last rung — the `default_agent`
// captured at the `config` hook — but a kickoff sent to an agent nothing
// resolves would fail the whole handoff, so any name other than this plugin's
// own role is confirmed against the resolved agent list first.
//
// Run: node --test --test-timeout=4000 test/handoff-agent-name.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"

import { handoffAgentName } from "../src/handoffwiring.js"
import { installAgents, DEFAULT_AGENT } from "../src/agents.js"
import { resetState } from "../src/state.js"
import { resetOverrides } from "../src/overrides.js"
import { resetPermissionGuardCache } from "../src/config.js"

// Nothing may reach the session API while the captured name is the plugin's
// own role — installAgents writes that role into every config, so there is
// nothing to confirm.
const noClient = new Proxy(
  {},
  {
    get() {
      throw new Error("the plugin's own role needs no lookup")
    },
  },
)

function clientResolving(names) {
  return {
    config: { get: async () => ({ data: { agent: {} } }) },
    app: { agents: async () => ({ data: names.map((name) => ({ name, mode: "primary" })) }) },
  }
}

beforeEach(() => {
  resetState()
  resetOverrides()
  resetPermissionGuardCache()
})

test("with no project default the plugin's own role answers, without a request", async () => {
  assert.equal(await handoffAgentName(noClient), DEFAULT_AGENT)
})

test("a project's own default_agent is what the replacement primary runs as", async () => {
  installAgents({ default_agent: "build" })
  assert.equal(await handoffAgentName(clientResolving(["build", "plan"])), "build")
})

test("a default_agent nothing resolves falls back to the plugin's role", async () => {
  installAgents({ default_agent: "build" })
  assert.equal(
    await handoffAgentName(clientResolving(["plan"])),
    DEFAULT_AGENT,
    "a kickoff to an unresolvable agent would fail the whole handoff",
  )
})

test("an unreadable agent list falls back rather than throwing", async () => {
  installAgents({ default_agent: "build" })
  const brokenClient = {
    config: { get: async () => ({ data: {} }) },
    app: {
      agents: async () => {
        throw new Error("no such route")
      },
    },
  }
  assert.equal(await handoffAgentName(brokenClient), DEFAULT_AGENT)
})
