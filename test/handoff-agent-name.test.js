// The agent a replacement primary is created under (src/handoffwiring.js).
//
// The handoff used to hard-code "orchestrator", so a project whose primary is
// called something else was replaced by an agent it never selected. The name
// now comes from the primary session's recorded agent, with `default_agent` as
// the fallback identification rung. A kickoff sent to an agent nothing
// resolves would fail the whole handoff, so any name other than this plugin's
// own role is confirmed against the resolved agent list first.
//
// Run: node --test --test-timeout=4000 test/handoff-agent-name.test.js

import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"

import { handoffAgentName, maybeRunPendingHandoff } from "../src/handoffwiring.js"
import { installAgents, DEFAULT_AGENT } from "../src/agents.js"
import { defaultAgentByDirectory, resetState } from "../src/state.js"
import { markHandoffPending, recordSessionAgent } from "../src/registry.js"
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

test("the replacement follows the primary session's selected agent", async () => {
  installAgents({ default_agent: "build" })
  recordSessionAgent("ses-selected-primary", "plan")
  assert.equal(
    await handoffAgentName(clientResolving(["build", "plan"]), "ses-selected-primary"),
    "plan",
  )
})

test("an unresolvable session agent falls back to the plugin's role", async () => {
  installAgents({ default_agent: "build" })
  recordSessionAgent("ses-unresolvable-primary", "missing")
  assert.equal(
    await handoffAgentName(clientResolving(["build"]), "ses-unresolvable-primary"),
    DEFAULT_AGENT,
    "a kickoff to an unresolvable agent would fail the whole handoff",
  )
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


test("the summary prompt reuses the agent resolved for the handoff", async () => {
  const sessionID = "ses-agent-name-reuse"
  const newSessionID = "ses-agent-name-reuse-new"
  const sent = []
  let messageReads = 0
  const summaries =
    "## PROJECT.md — project\n\n## TODO.md — todo\n\n## ARCHITECTURE.md — architecture"

  installAgents({ default_agent: "build" })
  recordSessionAgent(sessionID, "plan")

  const client = {
    config: { get: async () => ({ data: { agent: {} } }) },
    app: {
      agents: async () =>
        ({ data: ["build", "plan", "coder"].map((name) => ({ name, mode: "primary" })) }),
    },
    session: {
      get: async () => ({ data: {} }),
      messages: async () => {
        messageReads += 1
        if (messageReads === 1) {
          // Change the fallback after buildPrimaryHandoffDeps has resolved the
          // session agent. A second lookup would therefore choose "coder".
          defaultAgentByDirectory.set("", "coder")
          return { data: [] }
        }
        if (messageReads === 2) {
          return {
            data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "old" }] }],
          }
        }
        return {
          data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: summaries }] }],
        }
      },
      create: async () => ({ data: { id: newSessionID } }),
      promptAsync: async ({ path, body }) => {
        sent.push({ sessionID: path.id, agent: body.agent })
      },
      update: async () => ({ data: {} }),
    },
    tui: {
      showToast: async () => ({ data: true }),
      selectSession: async () => ({ data: {} }),
    },
  }

  markHandoffPending(sessionID)
  const result = await maybeRunPendingHandoff(client, sessionID)

  assert.equal(result.newSessionID, newSessionID)
  assert.deepEqual(sent, [
    { sessionID, agent: "plan" },
    { sessionID: newSessionID, agent: "plan" },
  ])
})
