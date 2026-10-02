/**
 * Whether a file the CLI is about to write CAN be written, asked before the
 * write — and the usage error a refused write becomes.
 *
 * A read-only checkout (a CI cache, a mounted volume, a `chmod -w` tree) fails
 * every derived-file write with a bare `EACCES: permission denied, open …`:
 * an SDK_ERROR naming a temp path, with no fix. It is the user's tree to fix,
 * so it is a usage error naming the path that blocks and what makes it work.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { displayPath } from "../util/rel-path.js";
import { shellWord } from "./command-line.js";
import { UsageError } from "./errors.js";

/**
 * The existing path that stops `file` being written — the file itself when it
 * exists read-only, else the nearest existing directory it would be created
 * under — or undefined when nothing does.
 */
export function unwritableBlocker(file: string): string | undefined {
  const target = resolve(file);
  if (existsSync(target) && !statSync(target).isDirectory() && !canWrite(target)) return target;
  // The directory a temp file and a rename (or a fresh file) are made in.
  let dir = dirname(target);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return canWrite(dir) ? undefined : dir;
}

function canWrite(path: string): boolean {
  return canAccess(path, constants.W_OK);
}

function canAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** Whether `err` is a write refused by permissions or a read-only filesystem. */
export function isUnwritableError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

/**
 * The refusal for `file`, which cannot be written: the path that blocks it,
 * the `chmod` that frees it, and `alternative` (a flag that writes elsewhere)
 * when the command has one.
 */
export function unwritableError(file: string, alternative?: string): UsageError {
  const blocker = unwritableBlocker(file) ?? dirname(resolve(file));
  const what = blocker === resolve(file) ? "is read-only" : `is in ${displayPath(blocker)}/, which is not writable`;
  return new UsageError(
    `Cannot write ${displayPath(resolve(file))}: it ${what}. ` +
      `Make it writable (\`chmod u+w ${shellWord(displayPath(blocker))}\`)${alternative === undefined ? "" : `, or ${alternative}`}.`,
  );
}

/** Refuse before anything happens when `file` could not be written. */
export function assertWritable(file: string, alternative?: string): void {
  if (unwritableBlocker(file) !== undefined) throw unwritableError(file, alternative);
}

/**
 * The refusal for `file`, which exists but cannot be read — for a record the
 * CLI reads before it rewrites, where writing without reading would discard
 * what it holds.
 */
export function unreadableError(file: string): UsageError {
  const shown = displayPath(resolve(file));
  return new UsageError(`Cannot read ${shown}: permission denied. Make it readable and writable (\`chmod u+rw ${shellWord(shown)}\`).`);
}

/**
 * {@link assertWritable} for a file that is read before it is rewritten: an
 * existing file that cannot be read is refused too, with a `chmod` that frees
 * both.
 */
export function assertReadWritable(file: string, alternative?: string): void {
  const target = resolve(file);
  if (existsSync(target) && !statSync(target).isDirectory() && !canAccess(target, constants.R_OK)) throw unreadableError(file);
  assertWritable(file, alternative);
}
