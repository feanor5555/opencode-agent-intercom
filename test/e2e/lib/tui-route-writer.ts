// Long-lived TUI-route publisher for the live pre-delete driver.
//
// Speaks the panel's own publish API (tui/src/route-file.ts) so the file the
// plugin reads is shaped the way a real panel would shape it. Stays alive so
// its pid is not dropped on read, publishes once at start, again when poked,
// and exits on `stop` or SIGTERM.
//
// argv: <server> <expectedPanel> <sessionID> <ctlDir> <label>
// `expectedPanel` is the role this writer must compute, not a value it writes:
// `publishTuiRoute` overwrites `panel` from the file (start order). A mismatch
// is a setup error. Optional env: TUI_ROUTE_FILE — test seam, otherwise the
// shared cache path.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  publishTuiRoute,
  setTuiRoutePanel,
  setTuiRoutePath,
  setTuiRouteServer,
  tuiRouteFilePath,
  tuiRoutePanel,
} from "../../../tui/src/route-file.ts"

const server = process.argv[2] ?? ""
const panelHint = process.argv[3] ?? "primary"
const sessionID = process.argv[4] ?? ""
const ctlDir = process.argv[5] ?? ""
const label = process.argv[6] ?? "writer"

if (!server || !sessionID || !ctlDir || !label) {
  process.stderr.write("usage: tui-route-writer.ts <server> <expectedPanel> <sessionID> <ctlDir> <label>\n")
  process.exit(2)
}

const routeFile = process.env.TUI_ROUTE_FILE
if (routeFile) setTuiRoutePath(routeFile)
setTuiRouteServer(server)
setTuiRoutePanel(panelHint)

mkdirSync(ctlDir, { recursive: true })

function writeState(tag: string, ok: boolean): void {
  const body = {
    ok,
    tag,
    pid: process.pid,
    sessionID,
    server,
    panel: tuiRoutePanel(),
    hint: panelHint,
    routeFile: tuiRouteFilePath(),
    at: Date.now(),
  }
  writeFileSync(join(ctlDir, `${label}.${tag}.json`), JSON.stringify(body, null, 2) + "\n")
  writeFileSync(join(ctlDir, `${label}.last.json`), JSON.stringify(body, null, 2) + "\n")
}

function publish(tag: string): boolean {
  const ok = publishTuiRoute(sessionID, Date.now())
  writeState(tag, ok)
  return ok
}

if (!publish("before")) {
  process.stderr.write(`${label}: first publish failed\n`)
  process.exit(2)
}
if (tuiRoutePanel() !== panelHint) {
  process.stderr.write(
    `${label}: computed panel ${tuiRoutePanel()} !== expected ${panelHint} (start order decides the role; the hint is not written)\n`,
  )
  process.exit(2)
}
writeFileSync(join(ctlDir, `${label}.ready`), String(process.pid))

const stopPath = join(ctlDir, "stop")
const pokePath = join(ctlDir, `${label}.republish`)

function shutdown(): void {
  try {
    writeFileSync(join(ctlDir, "stop"), "1")
  } catch {
    // already going down
  }
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

while (!existsSync(stopPath)) {
  if (existsSync(pokePath)) {
    try {
      unlinkSync(pokePath)
    } catch {
      // raced
    }
    publish("after")
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
}
process.exit(0)
