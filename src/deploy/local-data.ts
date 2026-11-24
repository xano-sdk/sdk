/**
 * A project's own engine data: `xano/data/`, a Xano Engine data directory that
 * `deploy --local` runs the engine on instead of a throwaway database.
 *
 * It is what `init --from <bundle>` unpacks a hosted workspace's export into
 * (see `src/emit/init-from-bundle.ts`), and it is the ONE directory in a project
 * that holds secrets in bulk: `xano.yaml` carries the hosted instance's keys
 * (so its tokens and encrypted values keep working), `sqlite/` its records, and
 * `storage/` its stored files. So every rule about it is a rule about what must
 * never leave this machine:
 *
 * - **Never committed.** The scaffold's `.gitignore` names it, and a deploy or
 *   an `init` that finds it re-adds the rule when it is missing
 *   (`src/emit/gitignore.ts`, `ensureLocalDataGitignored`).
 * - **Never packed.** Every walk that turns project files into an upload or an
 *   archive skips an engine data directory wherever it sits: a static build
 *   (`static-host.ts`), an app's source kept with its build (`app-source.ts`),
 *   and a hosted file an archive carries (`workspace/hosted-file.ts`). The
 *   backend tree's own walk (`filesUnder`) skips it too, so `pull` and a
 *   re-run of `init --from` neither list it nor touch it.
 * - **Never replaced.** A deploy into an engine running on it always merges, the
 *   way `--keep-data` does, and `--reset` is refused rather than honored
 *   (`src/emit/deploy-command.ts`).
 *
 * Node-only (it stats the filesystem); reached by lazy imports.
 */
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Where a project's data directory sits, relative to the project root, as docs and messages spell it. */
export const PROJECT_DATA_DIR = "xano/data";

/** The database file whose presence makes `xano/data/` a data directory an engine runs on. */
const DATABASE_FILE = join("sqlite", "xano.sqlite");

/** The absolute path of `dir`'s data directory, whether or not it exists. */
export function projectDataDir(dir: string): string {
  return resolve(dir, "xano", "data");
}

/**
 * Whether the project at `dir` has its own engine data: `xano/data/sqlite/xano.sqlite`
 * is there. Only the database counts — an empty `xano/data/` (or one holding a
 * stray file) is not something an engine could run on, and starting a
 * persistent engine on it would create a new, empty database in the project
 * that every later deploy then merges into.
 */
export function projectHasData(dir: string): boolean {
  return isFile(join(projectDataDir(dir), DATABASE_FILE));
}

/**
 * Whether `dir` is a Xano Engine data directory: it holds the engine's
 * configuration (`xano.yaml`) beside a `sqlite/` directory. The shape an
 * export bundle unpacks to and an engine leaves behind, wherever it sits —
 * which is what the packing walks test, since a data directory copied or moved
 * elsewhere in a project holds the same secrets.
 */
export function isEngineDataDir(dir: string): boolean {
  return isFile(join(dir, "xano.yaml")) && isDirectory(join(dir, "sqlite"));
}

/**
 * Whether `path` is, or sits under, a Xano Engine data directory
 * ({@link isEngineDataDir}). Walks up to the filesystem root; for the few
 * paths a deploy reads one at a time (a hosted file), never for a whole tree.
 */
export function insideEngineDataDir(path: string): boolean {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    if (isEngineDataDir(dir)) return true;
    if (dirname(dir) === dir) return false;
  }
}

// Node 20's `throwIfNoEntry: false` still throws ENOTDIR when a parent of `path` is a file (Node 22
// answers undefined), so any failure to stat is "not there".
function statOf(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

function isFile(path: string): boolean {
  return statOf(path)?.isFile() === true;
}

function isDirectory(path: string): boolean {
  return statOf(path)?.isDirectory() === true;
}
