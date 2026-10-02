/**
 * Node-only atomic file write: stage into a per-pid temp file, then rename into
 * place, so a crash can never leave a half-written file. Shared by the lock I/O
 * (`src/lock/io.ts`) and the OAuth token cache (`src/auth/store.ts`) — the one
 * place this crash-safety dance is defined, so the two can't drift.
 *
 * Reachable only from Node-only modules; never pulled into the browser-safe
 * `index.ts` surface.
 */
import { accessSync, constants, lstatSync, readlinkSync, statSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Write `contents` to `path` atomically. Pass `mode` for restrictive perms (e.g.
 * 0o600); without one, a file being replaced keeps its own mode.
 *
 * A `path` that is a symlink is written THROUGH: the temp file is staged beside
 * the link's final target and renamed over it, so the link keeps pointing at
 * the file it shares (a dotfiles checkout, a mounted secret) instead of being
 * replaced by a private copy.
 */
export function atomicWrite(path: string, contents: string, opts?: { mode?: number }): void {
  const target = linkTarget(path);
  const mode = opts?.mode ?? existingMode(target);
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, contents, mode !== undefined ? { encoding: "utf8", mode } : "utf8");
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The file a chain of symlinks at `path` ends at — `path` itself when it is no link. A dangling link resolves to the file it names. */
export function linkTarget(path: string): string {
  let current = path;
  // The kernel's own limit on a link chain; a loop deeper than this fails at the write.
  for (let hops = 0; hops < 40; hops++) {
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      return current;
    }
    if (!isLink) return current;
    current = resolve(dirname(current), readlinkSync(current));
  }
  return current;
}

/** The permission bits of the file at `path`, or `undefined` when there is none. */
function existingMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/**
 * Refuse a target the caller is not allowed to overwrite.
 *
 * {@link atomicWrite} replaces a file by RENAMING over it, and rename asks the
 * DIRECTORY for permission, not the file. So a target the owner deliberately
 * made read-only is replaced without complaint — the one behavior an in-place
 * `writeFileSync` got right for free, and silently losing it would overwrite a
 * file somebody locked on purpose.
 *
 * Separate from the write rather than folded into it: the callers that stage
 * their own state (the lock, the token cache) OWN their files outright and
 * should replace them whatever their mode says. Only a writer editing a file
 * the USER owns wants this, so only those writers ask for it.
 *
 * An absent file is writable by definition — that is a create, and the
 * directory answers for it.
 */
export function assertWritable(path: string): void {
  try {
    accessSync(path, constants.W_OK);
  } catch (err) {
    // ENOENT is the CREATE case, and the directory answers for that — so it is
    // the one failure that is not a refusal. Asked in one syscall rather than
    // two (exists, then writable), which is also the only version with no
    // window between the two answers.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
