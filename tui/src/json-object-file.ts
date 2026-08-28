// The disk half the three stores of this panel share: one JSON object per file
// under ~/.config/opencode, a test seam for the path, a guarded read and a
// guarded write. What each store puts into that object and takes out of it — the
// legacy "*" drop, the model-pair filter, the env/default resolution — stays in
// its own module.
//
// The read separates the two cases a panel write must not confuse. A file that
// is not there yet reads as empty, so the first write creates it. A file that is
// there but cannot be read or parsed throws, so the caller refuses to write over
// content it could not read: one stray character from a hand edit must not cost
// the user the keys this TUI knows nothing about. A body that parses to
// something other than a plain object ([], null, 42, "x") reads as empty and is
// replaced — there is no entry in it to keep.
//
// The write reports whether it reached the disk, so a caller whose write failed
// can put the true file state back into its signal instead of the value it meant
// to store.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface JsonObjectFile {
  // Test seam: point reads and writes at another file.
  setPath(p: string): void;
  // The file's own object. Throws for a file that is present but unreadable or
  // unparsable.
  readRaw(): Record<string, unknown>;
  // True when the object reached the disk.
  write(value: unknown): boolean;
}

export function createJsonObjectFile(fileName: string): JsonObjectFile {
  let path = join(homedir(), ".config", "opencode", fileName);
  return {
    setPath(p: string): void {
      path = p;
    },
    readRaw(): Record<string, unknown> {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
        throw err;
      }
      const raw = JSON.parse(text);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
      }
      return {};
    },
    write(value: unknown): boolean {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
        return true;
      } catch {
        return false;
      }
    },
  };
}
