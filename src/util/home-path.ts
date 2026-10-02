/**
 * A credential path as a shell would have read it. A leading `~` is expanded
 * by the shell only when unquoted and at the start of a word, so a path from a
 * CI YAML, a quoted argument, or `--config=~/…` arrives with the tilde intact —
 * and taken literally it names a directory called `~` under the cwd.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnvVar } from "./env.js";

/** Expand a leading `~` or `~/` to the home directory; every other path is returned unchanged. */
export function expandHome(path: string): string;
export function expandHome(path: string | undefined): string | undefined;
export function expandHome(path: string | undefined): string | undefined {
  if (path === undefined || !isHomeRelative(path)) return path;
  return join(homedir(), path.slice(1));
}

/** Whether `path` starts with a `~` that names the home directory (`~`, `~/…`), not `~user`. */
export function isHomeRelative(path: string): boolean {
  return /^~(?:$|[\\/])/.test(path);
}

/** {@link readEnvVar} for a path-valued variable, with a leading `~` expanded. */
export function readPathEnvVar(name: string): string | undefined {
  return expandHome(readEnvVar(name));
}
