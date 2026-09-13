// The panel's published route (tui/src/route-file.ts, wired in tui/src/tui.tsx:
// sampleRoute).
//
// The plugin moves the TUI off a session before it deletes that session
// (src/client.js: deleteSession → escapeTuiRouteOffSession), and the one thing
// it cannot see from its own side is where the TUI is looking: the panel runs
// in its own module graph, and where the TUI talks to `opencode serve` it runs
// in another process. This file is that channel, and the two properties it
// carries are the ones the escape stands on.
//
//   * a route naming no session is published as `null`. "The user is in no
//     session" has to be a fact in the file, or a stale entry from an earlier
//     navigation would speak for a user who has long left.
//   * the entry is keyed by the writing process and the dead writers go. A
//     route dies with the TUI that holds it, while the file outlives it, and
//     several opencode instances share the one file.
//
// The sample is also the repair for the blind spot the diagnosis names: the
// panel used to read the route only when something ended, so the one move that
// mattered sat in a 33-minute hole. It is sampled on the panel's own timers now
// and logged when it CHANGED, which dates the next one to the tick.
//
// Run: node --test --test-timeout=5000 test/tui-route-publish.test.js

import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  PLACEHOLDER_SERVER_URL,
  clientServerAddress,
  pruneTuiRoutes,
  publishTuiRoute,
  routeSessionID,
  routeWriterAlive,
  serverIdentity,
  setTuiRoutePath,
  setTuiRouteServer,
  setTuiRouteServerFromClient,
  tuiRouteFilePath,
  tuiRouteServer,
} from "../tui/src/route-file.ts"
import { PLACEHOLDER_SERVER_URL as PLUGIN_PLACEHOLDER } from "../src/client.js"
import { serverIdentity as pluginServerIdentity } from "../src/tuiroute.js"

const DIR = mkdtempSync(join(tmpdir(), "intercom-routefile-"))
const ROUTE_FILE = join(DIR, "tui-route.json")
setTuiRoutePath(ROUTE_FILE)

const CHILD = "ses_child"
const OTHER = "ses_other"

const deadPid = (() => {
  const run = spawnSync(process.execPath, ["-e", ""])
  assert.equal(run.status, 0, "the probe child did not run")
  return run.pid
})()

function body() {
  return JSON.parse(readFileSync(ROUTE_FILE, "utf8"))
}

const SELF = serverIdentity("", process.pid)

test.beforeEach(() => {
  writeFileSync(ROUTE_FILE, "{}\n")
  setTuiRouteServer("")
})

// ------------------------------------------------- what a route says

test("the session a route names, and the routes that name none", () => {
  assert.equal(routeSessionID({ name: "session", params: { sessionID: CHILD } }), CHILD)
  assert.equal(routeSessionID({ name: "home" }), null)
  assert.equal(routeSessionID({ name: "plugin", params: { sessionID: CHILD } }), null)
  assert.equal(routeSessionID({ name: "session", params: {} }), null)
  assert.equal(routeSessionID({ name: "session", params: { sessionID: "" } }), null)
  assert.equal(routeSessionID(undefined), null)
})

test("a live writer's route is kept, a dead one's is dropped, and junk with it", () => {
  const kept = pruneTuiRoutes(
    {
      [String(process.pid)]: { sessionID: CHILD, at: 5 },
      [String(deadPid)]: { sessionID: OTHER, at: 9 },
      notapid: { sessionID: OTHER, at: 9 },
      "-1": { sessionID: OTHER, at: 9 },
    },
    deadPid + 1000000,
  )
  assert.deepEqual(Object.keys(kept), [String(process.pid)])
  assert.deepEqual(kept[String(process.pid)], { sessionID: CHILD, at: 5, server: null })
})

test("this process's own key is dropped before it is written again", () => {
  const kept = pruneTuiRoutes({ [String(process.pid)]: { sessionID: CHILD, at: 5 } }, process.pid)
  assert.deepEqual(kept, {})
})

test("a writer that is gone cannot hold a route", () => {
  assert.equal(routeWriterAlive(process.pid), true)
  assert.equal(routeWriterAlive(deadPid), false)
  assert.equal(routeWriterAlive(0), false)
  assert.equal(routeWriterAlive(-1), false)
  assert.equal(routeWriterAlive(1.5), false)
})

// ------------------------------------------------- what is written

test("the route is published under this process's pid, with the sample time", () => {
  assert.equal(publishTuiRoute(CHILD, 1234), true)
  assert.deepEqual(body(), {
    [String(process.pid)]: { sessionID: CHILD, at: 1234, server: SELF },
  })
  assert.equal(tuiRouteFilePath(), ROUTE_FILE)
})

test("a route naming no session is published as null", () => {
  publishTuiRoute(CHILD, 1)
  publishTuiRoute(null, 2)
  assert.deepEqual(body(), {
    [String(process.pid)]: { sessionID: null, at: 2, server: SELF },
  })
})

test("another live instance's entry survives this one's write", () => {
  writeFileSync(
    ROUTE_FILE,
    JSON.stringify({
      [String(process.ppid)]: {
        sessionID: OTHER,
        at: 7,
        server: "url:http://127.0.0.1:4788",
      },
      [String(deadPid)]: { sessionID: OTHER, at: 7 },
    }) + "\n",
  )
  publishTuiRoute(CHILD, 8)
  const written = body()
  assert.deepEqual(written[String(process.ppid)], {
    sessionID: OTHER,
    at: 7,
    server: "url:http://127.0.0.1:4788",
  })
  assert.deepEqual(written[String(process.pid)], { sessionID: CHILD, at: 8, server: SELF })
  assert.equal(
    Object.prototype.hasOwnProperty.call(written, String(deadPid)),
    false,
    "and every write prunes the writers that are gone",
  )
})

test("a file nobody can parse is replaced rather than propagated", () => {
  writeFileSync(ROUTE_FILE, "{ not json")
  assert.equal(publishTuiRoute(CHILD, 3), true)
  assert.deepEqual(body(), {
    [String(process.pid)]: { sessionID: CHILD, at: 3, server: SELF },
  })
})

test("the write is atomic and leaves no temp file behind", () => {
  publishTuiRoute(CHILD, 4)
  assert.deepEqual(
    readdirSync(DIR).filter((f) => f.endsWith(".tmp")),
    [],
  )
  assert.equal(existsSync(ROUTE_FILE), true)
})

// ------------------------------------------------- which server it is

// A client double shaped like the SDK's: the transport carries the base URL,
// and reading its config asks nobody anything.
function clientAt(baseUrl, key = "_client") {
  return { [key]: { getConfig: () => ({ baseUrl }) } }
}

test("a TUI talking to a server over an address is that address", () => {
  assert.equal(serverIdentity("http://127.0.0.1:4788"), "url:http://127.0.0.1:4788")
  assert.equal(serverIdentity("http://127.0.0.1:4788/"), "url:http://127.0.0.1:4788")
})

test("a TUI whose server binds nothing is its own process", () => {
  // The interactive case: opencode runs the server IN this process and reports
  // the placeholder, an address nothing listens on. Both halves then name the
  // process, and they name the same one because it is one process.
  assert.equal(serverIdentity(""), `pid:${process.pid}`)
  assert.equal(serverIdentity(undefined, 4711), "pid:4711")
  assert.equal(clientServerAddress(clientAt(PLACEHOLDER_SERVER_URL)), "")
  assert.equal(setTuiRouteServerFromClient(clientAt(PLACEHOLDER_SERVER_URL)), `pid:${process.pid}`)
})

test("the address comes off the client the panel already holds, in either shape", () => {
  assert.equal(clientServerAddress(clientAt("http://127.0.0.1:4788")), "http://127.0.0.1:4788")
  assert.equal(
    clientServerAddress(clientAt("http://127.0.0.1:4788/", "client")),
    "http://127.0.0.1:4788",
  )
  assert.equal(
    setTuiRouteServerFromClient(clientAt("http://127.0.0.1:4788")),
    "url:http://127.0.0.1:4788",
  )
})

test("a client that names no server leaves the panel on its own process", () => {
  for (const client of [
    undefined,
    {},
    { _client: {} },
    { _client: { getConfig: () => ({}) } },
    {
      _client: {
        getConfig: () => {
          throw new Error("no config")
        },
      },
    },
  ]) {
    assert.equal(clientServerAddress(client), "")
    assert.equal(setTuiRouteServerFromClient(client), `pid:${process.pid}`)
  }
})

test("the published server is the one that was read off the client", () => {
  setTuiRouteServerFromClient(clientAt("http://127.0.0.1:4788"))
  publishTuiRoute(CHILD, 11)
  assert.deepEqual(body(), {
    [String(process.pid)]: {
      sessionID: CHILD,
      at: 11,
      server: "url:http://127.0.0.1:4788",
    },
  })
})

test("a route published before the client was read still names this process", () => {
  // The mount order can only be panel-first for one write at most, and an
  // unscoped entry would be moved by every server on the machine.
  setTuiRouteServer("")
  assert.equal(tuiRouteServer(), `pid:${process.pid}`)
  publishTuiRoute(CHILD, 12)
  assert.equal(body()[String(process.pid)].server, `pid:${process.pid}`)
})

test("another writer's server survives this panel's write, and none is invented", () => {
  const kept = pruneTuiRoutes(
    {
      [String(process.pid)]: { sessionID: OTHER, at: 1, server: "url:http://127.0.0.1:4788" },
      [String(process.ppid)]: { sessionID: OTHER, at: 1 },
    },
    deadPid + 1000000,
  )
  assert.equal(kept[String(process.pid)].server, "url:http://127.0.0.1:4788")
  assert.equal(kept[String(process.ppid)].server, null, "an entry that named none keeps none")
})

test("both halves derive the identity the same way, character for character", () => {
  // The plugin reads what the panel writes; a divergence here is a route
  // escape that silently never fires.
  assert.equal(PLACEHOLDER_SERVER_URL, PLUGIN_PLACEHOLDER)
  for (const [address, pid] of [
    ["http://127.0.0.1:4788", 4711],
    ["http://127.0.0.1:4788/", 4711],
    ["", 4711],
    [undefined, 4711],
  ]) {
    assert.equal(serverIdentity(address, pid), pluginServerIdentity(address, pid))
  }
})

// ------------------------------------------------- how the panel is wired

const source = readFileSync(
  fileURLToPath(new URL("../tui/src/tui.tsx", import.meta.url)),
  "utf8",
)

function bodyOf(marker) {
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `marker not in tui.tsx: ${marker}`)
  assert.equal(source.indexOf(marker, start + 1), -1, `marker occurs twice: ${marker}`)
  const end = source.indexOf("\n  };", start)
  assert.notEqual(end, -1, `no end found for: ${marker}`)
  return source.slice(start, end)
}

test("the sample publishes and logs only what changed", () => {
  const sample = bodyOf("const sampleRoute = (): void => {")
  assert.match(sample, /const route = api\.route\.current;/)
  assert.match(sample, /const sessionID = routeSessionID\(route\);/)
  assert.match(sample, /if \(sessionID === lastRouteSample\) return;/)
  assert.match(sample, /lastRouteSample = sessionID;/)
  assert.match(sample, /publishTuiRoute\(sessionID\)/)
  assert.ok(
    sample.indexOf("if (sessionID === lastRouteSample) return;") <
      sample.indexOf("publishTuiRoute(sessionID)"),
    "an unchanged route costs neither a write nor a log line",
  )
  assert.match(source, /let lastRouteSample: string \| null \| undefined = undefined;/)
  assert.match(
    source,
    /import \{\n  publishTuiRoute,\n  routeSessionID,\n  setTuiRouteServerFromClient,\n\} from "\.\/route-file\.ts";/,
  )
})

test("the sample writes one debug line carrying the route it moved to", () => {
  const sample = bodyOf("const sampleRoute = (): void => {")
  assert.match(sample, /debugLog\("tui route sample", \{/)
  for (const field of [/route: route\.name,/, /routeSessionID: sessionID,/, /published,/]) {
    assert.match(sample, field)
  }
})

test("the route is sampled at mount and on both of the panel's timers", () => {
  // The 30 s file refresh is what dates a move for the log; the elapsed tick is
  // what keeps the published sample fresh enough for the plugin to escape on.
  assert.match(bodyOf("const refreshFileState = (): void => {"), /sampleRoute\(\);/)
  assert.match(source, /\n  sampleRoute\(\);\n  const tick = setInterval\(\(\) => \{/)
  assert.match(source, /setNowMs\(Date\.now\(\)\);\n\s*sampleRoute\(\);\n\s*\}, ELAPSED_TICK_MS\);/)
  const samples = source.match(/sampleRoute\(\)/g) ?? []
  assert.equal(samples.length, 3, "the mount, the elapsed tick and the file refresh")
})

test("the panel publishes the route and navigates on nothing of its own account", () => {
  // The late guard stays exactly as it was: this sample is a publication, not
  // a second escape.
  const sample = bodyOf("const sampleRoute = (): void => {")
  assert.equal(sample.includes("api.route.navigate("), false)
  assert.equal(sample.includes("escapeRoute("), false)
})

test("the panel reads its server off the client once, at mount, before it publishes", () => {
  assert.match(
    source,
    /const routeServer = setTuiRouteServerFromClient\(api\.client\);/,
    "the identity comes from the client the panel holds, not from a request",
  )
  assert.match(source, /debugLog\("tui route server", \{ server: routeServer \}\);/)
  const reads = source.match(/setTuiRouteServerFromClient\(/g) ?? []
  assert.equal(reads.length, 1, "read once: the client cannot change under the panel")
  assert.ok(
    source.indexOf("setTuiRouteServerFromClient(api.client)") <
      source.indexOf("\n  sampleRoute();\n  const tick = setInterval"),
    "an unscoped route must not reach the file",
  )
})
