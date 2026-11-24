/**
 * The app's source archive a static publish may send beside its build
 * (`--static-source`): the checks that run before anything is written.
 *
 * Its own module, free of `node:zlib`, so the deploy commands can refuse a bad
 * path before sign-in without pulling the upload transport in. The caller
 * hands this archive over and the build route keeps it as the build's
 * original; without one, the publish archives the app's folder itself
 * (`app-source.ts`, DEV-10124).
 */
import { statSync } from "node:fs";
import { basename } from "node:path";

/** The cap on each archive a static upload carries: the build, and the source beside it. */
export const STATIC_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** The archive kinds `source` accepts, by file name. */
export type StaticSourceKind = "zip" | "tar.gz";

/**
 * A source archive refused by {@link assertStaticSource}. `missing`: nothing is
 * at the path (a missing local input), as against a path that names the wrong thing.
 */
export class StaticSourceError extends Error {
  override readonly name = "StaticSourceError";
  constructor(
    message: string,
    readonly missing = false,
  ) {
    super(message);
  }
}

/**
 * Refuse a source archive that cannot be sent: not named as a `.zip`, `.tar.gz`
 * or `.tgz`, not there, not a file, empty, or over the upload cap. Returns the
 * archive's kind.
 *
 * `label` names where the path came from (`--static-source`).
 */
export function assertStaticSource(
  path: string,
  label?: string,
  maxBytes: number = STATIC_UPLOAD_MAX_BYTES,
): StaticSourceKind {
  const where = `${label === undefined ? "" : `${label} `}${path}`;
  const kind = staticSourceKind(path);
  if (kind === undefined) {
    throw new StaticSourceError(
      `${where}: not a .zip, .tar.gz or .tgz file. The source is sent as the archive it is, so pass one of those.`,
    );
  }
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) throw new StaticSourceError(`${where}: file not found.`, true);
  if (!stat.isFile()) throw new StaticSourceError(`${where}: not a file.`);
  if (stat.size === 0) throw new StaticSourceError(`${where}: the file is empty.`);
  if (stat.size > maxBytes) {
    const mb = (n: number): string => `${Number((n / (1024 * 1024)).toFixed(2))} MB`;
    throw new StaticSourceError(
      `${where}: ${mb(stat.size)}, over the ${mb(maxBytes)} cap for a static upload. ` +
        `Leave dependencies and build output (node_modules, dist) out of the archive.`,
    );
  }
  return kind;
}

/** The archive kind a file name says, or `undefined` for any other name. */
export function staticSourceKind(path: string): StaticSourceKind | undefined {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".zip")) return "zip";
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) return "tar.gz";
  return undefined;
}
