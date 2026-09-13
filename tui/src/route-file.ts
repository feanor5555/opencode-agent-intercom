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
//   { "<this process's pid>": { "sessionID": "ses_x" | null, "at": <epoch ms>,
//                               "server": "pid:4711" | "url:http://127.0.0.1:4788" } }
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
// `server` says which server this route belongs to, and it is what keeps a
// second TUI on the machine out of a delete that has nothing to do with it: a
// session id from another server names nothing here, so the plugin moves only
// the writers that are its own. Both halves derive it the same way
// (`serverIdentity`, mirrored in src/tuiroute.js, character for character):
// `url:<base url>` where the TUI talks to an `opencode serve` over an address,
// and `pid:<this process's pid>` where it does not — an interactive `opencode`
// runs the server IN this process and reports the placeholder address nothing
// listens on, so the process is the server. Written from `api.client`'s own
// base URL, which the panel already holds, and never from a request.
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
  // The server this route belongs to, or null for an entry that names none —
  // a panel bundle from before this field.
  server: string | null;
}

export type TuiRouteFileBody = Record<string, TuiRouteEntry>;

// The base URL opencode hands a plugin whose server binds no socket at all:
// an interactive `opencode` runs the server in this very process. It is the
// address of no server, so it never becomes an identity of its own. The same
// constant stands in src/client.js as PLACEHOLDER_SERVER_URL.
export const PLACEHOLDER_SERVER_URL = "http://localhost:4096";

let routePath = join(
  homedir(),
  ".cache",
  "opencode-agent-intercom",
  "tui-route.json",
);

// The server identity published with every route of this process. Empty until
// `setTuiRouteServerFromClient` has run, and then never empty; `tuiRouteServer`
// falls back to this process while it is.
let serverKey = "";

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

// The identity of the server a route belongs to. `url:<address>` where the TUI
// talks to a server over one, `pid:<pid>` where it does not — the plugin half
// derives its own the same way (src/tuiroute.js: serverIdentity), and the two
// must agree character for character.
export function serverIdentity(
  address: string | null | undefined,
  pid: number = process.pid,
): string {
  const normalized = typeof address === "string" ? address.replace(/\/+$/, "") : "";
  return normalized ? `url:${normalized}` : `pid:${pid}`;
}

// The base URL an opencode SDK client is configured with, "" where it names no
// server: no readable transport, or the placeholder of an in-process server.
// The transport is the client's own — `_client` on a root-style client,
// `client` on a v2 one — and reading its config asks nobody anything.
export function clientServerAddress(client: unknown): string {
  const candidates = [
    (client as { _client?: { getConfig?: () => { baseUrl?: unknown } } } | undefined)?._client,
    (client as { client?: { getConfig?: () => { baseUrl?: unknown } } } | undefined)?.client,
  ];
  for (const candidate of candidates) {
    let baseUrl: unknown;
    try {
      baseUrl = candidate?.getConfig?.()?.baseUrl;
    } catch {
      // a client shape without a readable config names no server
      continue;
    }
    if (typeof baseUrl !== "string" || baseUrl === "") continue;
    const normalized = baseUrl.replace(/\/+$/, "");
    if (normalized === PLACEHOLDER_SERVER_URL) return "";
    return normalized;
  }
  return "";
}

// Records which server this panel is attached to, read off the client the panel
// already holds. Called once at mount (./tui.tsx); until it has, a published
// route names this process, which is the right answer for every TUI whose
// server runs inside it.
export function setTuiRouteServerFromClient(client: unknown): string {
  serverKey = serverIdentity(clientServerAddress(client));
  return serverKey;
}

// Test seam: set the published identity directly.
export function setTuiRouteServer(identity: string): void {
  serverKey = typeof identity === "string" ? identity : "";
}

export function tuiRouteServer(pid: number = process.pid): string {
  return serverKey || serverIdentity("", pid);
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
    const entry = value as { sessionID?: unknown; at?: unknown; server?: unknown };
    out[key] = {
      sessionID:
        typeof entry.sessionID === "string" && entry.sessionID !== ""
          ? entry.sessionID
          : null,
      at: typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0,
      // Another writer's server is carried through untouched: this process
      // rewrites the whole file and must not strip what it does not own, nor
      // invent one for an entry that named none.
      server:
        typeof entry.server === "string" && entry.server !== "" ? entry.server : null,
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
  body[String(pid)] = { sessionID, at: now, server: tuiRouteServer(pid) };
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
