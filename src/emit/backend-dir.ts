/**
 * The one place that answers "which directory holds this project's backend?"
 *
 * `xanosdk init` writes it as `xano/`, and for a scaffolded project every answer
 * here is that directory. But the layout is a CONVENTION, not a requirement —
 * `assertProjectDir` says so outright, refusing to check for `xano/` because
 * "requiring `xano/` would reject a workspace layout where the backend is a
 * sibling" — so the sidecar resolvers must not hard-join {@link XANO_DIR} onto
 * the project root. A project whose backend sits in `backend/` would then have
 * its `xano/.env` read out of a directory holding no source at all, silently,
 * and `secrets fill` would crash on an ENOENT writing into a directory that
 * does not exist.
 *
 * Two questions, because the callers genuinely have different information, and
 * collapsing them would make one of them guess:
 *
 *   • {@link backendDirFor} — a command that was HANDED an entry file
 *     (`export`, `deploy <file>`, `preflight`, `promote`, `secrets fill`).
 *     Nothing needs discovering: the caller named the source, and a file that
 *     configures that source belongs beside it.
 *   • {@link backendDirIn} — a command that was handed only a directory
 *     (`env pull`, a bare `deploy`). This one has to look, so it looks at
 *     ARTIFACTS and declines rather than guessing, following `project-detect.ts`
 *     — detection exists to stop the CLI asserting things about a project it
 *     cannot see, so it must never invent one more.
 *
 * Node-only (`node:fs`), reached from the lazily-imported command modules.
 */
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { XANO_DIR } from "./scaffold.js";
import { relForwardSlash } from "../util/rel-path.js";

/** The marker a decode (`generate`, `init --from`, `pull`) writes at the top of the tree it owns. */
const DECODE_MARKER = ".xanosdk-codegen.json";

export { projectRootFrom } from "../util/project-root.js";
import { projectRootFrom } from "../util/project-root.js";

/**
 * The backend directory an ENTRY FILE belongs to: the TOP-LEVEL directory under
 * the project root that the entry sits inside.
 *
 * Not simply the entry's own directory, which is the reading that breaks a
 * nested entry: `xano/nested/entry.ts` re-exporting the real registry belongs to
 * `xano/`, and resolving it to `xano/nested/` would look for the values one
 * directory below where every other command puts them. The top-level segment is
 * the same answer for `xano/index.ts` and for `xano/a/b/entry.ts`, which is what
 * makes "run it from a subdirectory" keep working.
 *
 * Deliberately not conditional on any file existing there (the nested cases
 * below read a lock only where its absence lands on the same directory). A
 * fallback-when-absent rule would resolve `.env` beside the entry and
 * `.secrets.json` under `xano/` in the same project, purely because one of them
 * happened to have been written already — and the "no `xano/.env` found" report
 * would then name a path with no relationship to the source it is configuring.
 * One entry location, one answer, every run.
 *
 * Where the backend is NOT a direct child of the root (`suites/<name>/xano/`),
 * the top-level segment is shared by every backend under it, so the entry's own
 * backend wins (see {@link nestedBackendDir}): the nearest `xano/`, else the
 * nearest `xano.lock`, else the entry's own directory — where the first export
 * puts that lock. Only the scaffold's name or a lock tells
 * `suites/a/xano/index.ts` from `xano/nested/entry.ts`, and the last step is the
 * lock's own destination, so the answer does not move when the lock appears.
 *
 * The ROOT is the single exception, and it is not a special case so much as the
 * rule holding: a `.env` at the project root is the FRONTEND's (Vite reads it
 * from there), so treating the root as the backend directory would ship every
 * frontend variable to the workspace as backend env. A project whose entry sits
 * at the root keeps the `xano/` answer it has always had.
 *
 * A DECODED tree answers for itself, and that comes first: the nearest directory
 * between the entry and the project root holding a decode's marker
 * (`.xanosdk-codegen.json`) is the backend directory. `generate --out <dir>`
 * writes a bare tree whose `.env`, `.secrets.json` and `.env.example` sit beside
 * its `index.ts`, and a tree that is its own project root (the `package.json`
 * its load error asks for, added in the tree) or sits deeper inside one was
 * otherwise read from `<root>/xano/` or the project's top-level directory —
 * files that do not exist — while the ones generate wrote were never read. The
 * marker is an artifact only a decode writes, so this is grounded, not guessed;
 * a scaffolded project's marker is in `xano/`, which is the answer it had anyway.
 */
export function backendDirFor(entryFile: string): string {
  const dir = dirname(resolve(entryFile));
  const root = projectRootFrom(dir);
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, DECODE_MARKER))) return at;
    if (at === root || dirname(at) === at || !at.startsWith(root)) break;
  }
  // Below the marker, the backend directory is the one the scaffold's name and
  // the lock point at, before the first segment is guessed. The first
  // segment is only right when the backend is a direct child of the root; under
  // a shared parent (`suites/<name>/xano/`) every backend would read one `.env`.
  const nested = nestedBackendDir(dir, root);
  if (nested !== undefined) return nested;
  // `relForwardSlash` answers "" for a directory outside the root, and for the
  // root itself. Neither names a backend directory, so both take the scaffold's.
  const top = relForwardSlash(root, dir).split("/")[0] ?? "";
  return join(root, top === "" ? XANO_DIR : top);
}

/**
 * The backend directory of an entry more than one directory below the root, in
 * the order that keeps the answer put across the first export:
 *
 *   1. the nearest ancestor named `xano/` — the scaffold's own name, which no
 *      file has to exist for and which a lock written into one of its
 *      subdirectories (`xano/functions/xano.lock`) must not pull the env out of;
 *   2. the nearest ancestor holding `xano.lock`, the walk `nearestLockPath` takes;
 *   3. the entry's own directory, which is where that lock LANDS on a first
 *      export. Answering anything else here would move the env and secrets files
 *      the moment the export finished, and drop the values already in them.
 *
 * The root itself never counts — a root `.env` is the frontend's. Undefined for
 * an entry directly inside the root's first segment or outside the root, which
 * keep the first-segment answer.
 */
function nestedBackendDir(dir: string, root: string): string | undefined {
  const rel = relForwardSlash(root, dir);
  if (rel === "" || !rel.includes("/")) return undefined;
  const ancestors: string[] = [];
  for (let at = dir; at !== root && dirname(at) !== at; at = dirname(at)) ancestors.push(at);
  return (
    ancestors.find((at) => basename(at) === XANO_DIR) ??
    ancestors.find((at) => existsSync(join(at, "xano.lock"))) ??
    dir
  );
}

/**
 * The backend directory of the project at `projectRoot`, discovered.
 *
 * `xano/` wins whenever it exists, so no scaffolded project's answer can move —
 * not even one carrying a second backend-shaped directory from a migration.
 *
 * Failing that, the search looks one level down for a directory holding BOTH an
 * `index.ts` and a `xano.lock`. The lock is what makes this artifact-grounded
 * rather than a guess: it is written by an export and by nothing else, so its
 * presence is the project stating that this directory is a Xano SDK backend. An
 * `index.ts` alone would match `src/`, `frontend/` and half the tree.
 *
 * TWO candidates decline, and decline to the `xano/` fallback rather than to
 * `undefined`, because every caller needs a path to name in its message and
 * `xano/` is the path those messages have always named. The decline matters
 * more than the find: these paths get WRITTEN to, so a wrong answer is not a
 * failure, it is a secret in a directory nobody is watching.
 */
export function backendDirIn(projectRoot: string): string {
  const root = resolve(projectRoot);
  const scaffolded = join(root, XANO_DIR);
  if (existsSync(scaffolded)) return scaffolded;

  let found: string | undefined;
  let entries: readonly string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return scaffolded;
  }
  for (const name of entries) {
    // `node_modules` carries a published SDK's own fixtures and any consumed
    // module's shipped tree, so a scan through it finds a lock per dependency.
    if (name === "node_modules" || name.startsWith(".")) continue;
    const dir = join(root, name);
    if (!existsSync(join(dir, "xano.lock")) || !existsSync(join(dir, "index.ts"))) continue;
    if (found !== undefined) return scaffolded; // two candidates — decline
    found = dir;
  }
  return found ?? scaffolded;
}

/**
 * The backend directory a command will act on, honoring `--backend-dir`.
 *
 * Returned project-relative with `/` separators, because that is what the
 * callers compose paths and messages from.
 *
 * The flag wins when given, because discovery has two states it cannot resolve
 * on its own — a project carrying two backend-shaped directories, where
 * {@link backendDirIn} declines on principle, and a project that has never run
 * an export and so has no `xano.lock` to be found by. Both are reachable states
 * for a real project, and neither is a useful moment to be told the tool cannot
 * tell which directory the backend is.
 *
 * Shared rather than written per command for the reason everything else in this
 * module is: `pull` REPLACES the directory and `env pull` writes a live secret
 * into it, so two readings of the same flag would put a confirmation and a write
 * in different places.
 *
 * The containment check is the caller-side twin of the one `pull` runs over the
 * SOURCE's paths. A flag naming somewhere outside the project is a request to
 * replace or write into a directory this project does not own, so it is refused
 * rather than resolved.
 */
export function resolveBackendDir(
  cwd: string,
  dir: string | undefined,
  refuse: (message: string) => Error,
): string {
  if (dir === undefined) return relForwardSlash(cwd, backendDirIn(cwd)) || XANO_DIR;
  const rel = relForwardSlash(cwd, resolve(cwd, dir));
  if (rel === "") {
    throw refuse(
      `--backend-dir must name a directory inside this project, and "${dir}" is not one.`,
    );
  }
  return rel;
}
