/**
 * `--capture`: write each round-tripped function's fetched persisted JSON to a
 * file. That JSON is the shape the golden corpus mirrors, so a captured file is
 * a candidate an SDK maintainer can promote into `test/fixtures/` (a reviewed,
 * manual step — capture only produces candidates).
 *
 * Node-only; lazily reached through the command.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { fixtureDirForKind } from "./kinds.js";
import type { RoundTripEntry } from "./loop.js";

/** A file written by capture. */
export interface CapturedFile {
  name: string;
  path: string;
}

/**
 * Write the fetched JSON for each entry that has one, into a kind-scoped
 * subdirectory that maps to the corpus layout (`dbo`→`tables/`,
 * `function`→`statements/`, …) so a captured file is a `cp` away from
 * `test/fixtures/<dir>/`. `outDir` defaults to `./validate-out`. Entries whose
 * kind is unregistered fall back to a flat filename; entries without a `fetched`
 * body (e.g. `missing`) are skipped.
 */
export function captureFixtures(entries: RoundTripEntry[], outDir = "validate-out"): CapturedFile[] {
  const written: CapturedFile[] = [];
  const madeDirs = new Set<string>();
  for (const entry of entries) {
    if (entry.fetched === undefined) continue;
    const dir = fixtureDirForKind(entry.kind);
    const path =
      dir === undefined
        ? resolvePath(outDir, `${safeName(entry.name)}.json`)
        : resolvePath(outDir, dir, `${safeName(entry.name)}.json`);
    const parent = dirname(path);
    // Kind-scoped captures share a directory — create each parent once.
    if (!madeDirs.has(parent)) {
      mkdirSync(parent, { recursive: true });
      madeDirs.add(parent);
    }
    writeFileSync(path, JSON.stringify(entry.fetched, null, 2) + "\n", "utf8");
    written.push({ name: entry.name, path });
  }
  return written;
}

/** Keep a filename filesystem-safe without losing readability. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned === "" ? "fixture" : cleaned;
}
