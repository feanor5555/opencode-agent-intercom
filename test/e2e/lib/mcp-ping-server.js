// Local stdio MCP server for the mcp-after e2e driver. One tool: ping → pong.
// No network. Speaks JSON-RPC over stdin/stdout as NDJSON, and also accepts
// LSP-style Content-Length frames so either transport opencode might use works.

import { stdin, stdout, stderr } from "node:process"

const SERVER_INFO = { name: "e2eping", version: "1.0.0" }
const PING_TOOL = {
  name: "ping",
  description: "Returns the literal pong. No arguments, no side effects, no network.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}

function send(msg) {
  stdout.write(JSON.stringify(msg) + "\n")
}

function result(id, value) {
  if (id === undefined || id === null) return
  send({ jsonrpc: "2.0", id, result: value })
}

function fail(id, code, message) {
  if (id === undefined || id === null) return
  send({ jsonrpc: "2.0", id, error: { code, message } })
}

function handle(msg) {
  if (!msg || typeof msg !== "object") return
  const { id, method, params } = msg
  if (!method) return
  if (method === "initialize") {
    const version = (params && params.protocolVersion) || "2024-11-05"
    result(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    })
    return
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return
  if (method === "ping") {
    result(id, {})
    return
  }
  if (method === "tools/list") {
    result(id, { tools: [PING_TOOL] })
    return
  }
  if (method === "tools/call") {
    const name = params && params.name
    if (name === "ping") {
      result(id, { content: [{ type: "text", text: "pong" }], isError: false })
      return
    }
    fail(id, -32601, `unknown tool: ${name}`)
    return
  }
  if (id !== undefined && id !== null) fail(id, -32601, `unknown method: ${method}`)
}

let buffer = ""
stdin.setEncoding("utf8")
stdin.on("end", () => process.exit(0))
stdin.on("data", (chunk) => {
  buffer += chunk
  for (;;) {
    if (buffer.startsWith("Content-Length:")) {
      const headerEnd = buffer.indexOf("\r\n\r\n")
      if (headerEnd < 0) return
      const n = Number(buffer.slice("Content-Length:".length, buffer.indexOf("\r\n")).trim())
      if (!Number.isFinite(n) || n < 0) {
        buffer = buffer.slice(headerEnd + 4)
        continue
      }
      const start = headerEnd + 4
      if (buffer.length < start + n) return
      const body = buffer.slice(start, start + n)
      buffer = buffer.slice(start + n)
      try {
        handle(JSON.parse(body))
      } catch (err) {
        stderr.write(`e2eping: bad json: ${err.message}\n`)
      }
      continue
    }
    const nl = buffer.indexOf("\n")
    if (nl < 0) return
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line))
    } catch (err) {
      stderr.write(`e2eping: bad json: ${err.message}\n`)
    }
  }
})
