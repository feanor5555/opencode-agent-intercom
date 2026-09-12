// The panel's half of the route escape: publishing where this TUI's view is,
// so the plugin can move it OFF a session before it deletes that session.
//
// The panel already guards the route itself — `escapeRoute` in ./tui.tsx, on
// `session.deleted`, the poll's reap and `session.idle`. That guard cannot win
// the deletion case: opencode's own bus handler answers `session.deleted` for
// the session on screen by navigating to its start page, and it gets there
// first, so the panel reads `api.route.current` and finds `home` — the route on
// the dying session is gone before anything of ours can read it. The escape
// therefore has to happen BEFORE the DELETE, which is the plugin's side of the
// wire (src/client.js: deleteSession → escapeTuiRouteOffSession), and the one
// thing that side cannot see is where this TUI is looking.
//
// So the panel publishes it, the mirror image of ./endless-pause-file.ts:
//
//   ~/.cache/opencode-agent-intercom/tui-route.json
//   { "<this process's pid>": { "sessionID": "ses_x" | null, "at": <epoch ms> } }
//
// `sessionID` is null for a route that names no session — the start page, the
// plugin's own route — because "the user is in no session" has to be a
// published fact and not an absence a stale entry could impersonate. `at` is
// what lets the plugin tell a sample taken after its own last move from one
// taken before it, and the pid is what makes an entry droppable: a route dies
// with the TUI that holds it, while the file outlives it. Several opencode
// instances share the file, each owning its own key, and every write prunes the
// keys whose writer is gone.
//
// Written only when the route CHANGES (./tui.tsx: sampleRoute), so the steady
// state costs nothing at all — one small write per navigation.
//
// Nothing here throws into the TUI: a write that fails costs the plugin its
// knowledge of the route, which puts the escape back exactly where it stood
// before this existed.

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// One published route, as it stands in the file.
export interface TuiRouteEntry {
  // The session the TUI is showing, or null for a route that names none.
  sessionID: string | null;
  // Epoch ms the sample was taken.
  at: number;
}

export type TuiRouteFileBody = Record<string, TuiRouteEntry>;

let routePath = join(
  homedir(),
  ".cache",
  "opencode-agent-intercom",
  "tui-route.json",
);

// Test seam: point reads and writes at another file.
export function setTuiRoutePath(p: string): void {
  routePath = p;
}

export function tuiRouteFilePath(): string {
  return routePath;
}

// The session a route names, or null where it names none. The `params` bag
// belongs to the session variant of the route union alone, so the name is what
// narrows it — the same reading `escapeRoute` takes.
export function routeSessionID(route: unknown): string | null {
  const r = route as { name?: unknown; params?: { sessionID?: unknown } } | undefined;
  if (!r || r.name !== "session") return null;
  const id = r.params?.sessionID;
  return typeof id === "string" && id !== "" ? id : null;
}

// Whether the process that wrote an entry is still running. `kill(pid, 0)`
// sends no signal and only asks whether the id can be signalled: EPERM is a
// live process owned by somebody else, ESRCH one that is gone.
export function routeWriterAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// The entries of a parsed file body worth keeping: shaped like an entry, keyed
// by a live pid, and not this process's own key — the caller writes that one
// itself. Pure, so the drop rules can be asserted without a filesystem or a
// process table.
export function pruneTuiRoutes(
  raw: unknown,
  self: number,
  isAlive: (pid: number) => boolean = routeWriterAlive,
): TuiRouteFileBody {
  const out: TuiRouteFileBody = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const pid = Number(key);
    if (!Number.isInteger(pid) || pid <= 0 || pid === self) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (!isAlive(pid)) continue;
    const entry = value as { sessionID?: unknown; at?: unknown };
    out[key] = {
      sessionID:
        typeof entry.sessionID === "string" && entry.sessionID !== ""
          ? entry.sessionID
          : null,
      at: typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0,
    };
  }
  return out;
}

// The file's own object, or `{}` for a file that is not there, cannot be read
// or does not parse. A body nobody could read is a body this panel replaces:
// every key in it belongs to a TUI process and this one owns its own.
function readRoutes(): unknown {
  try {
    return JSON.parse(readFileSync(routePath, "utf8"));
  } catch {
    return {};
  }
}

// Publishes this process's route. Atomic replace — a sibling temp file renamed
// over the target — so the plugin never reads a half-written object. Returns
// whether it reached the disk.
export function publishTuiRoute(
  sessionID: string | null,
  now: number = Date.now(),
  pid: number = process.pid,
): boolean {
  const body = pruneTuiRoutes(readRoutes(), pid);
  body[String(pid)] = { sessionID, at: now };
  const tmp = `${routePath}.${pid}.tmp`;
  try {
    mkdirSync(join(routePath, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, routePath);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    return false;
  }
}
