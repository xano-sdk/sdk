/**
 * One spelling of "this path, relative to that root, with forward slashes".
 *
 * Four call sites needed it at once when the CLI stopped assuming its backend
 * lives in `xano/`: a `.gitignore` entry, the `git rm --cached <path>` a refusal
 * tells the reader to run, the file a build reports having opened, and the entry
 * a bare `deploy` echoes back. All four are strings a PERSON reads or pastes, so
 * all four want the same two properties, and getting either wrong in one of them
 * is a paper cut the other three do not have.
 *
 * FORWARD SLASHES, because a `.gitignore` pattern and a git pathspec are
 * `/`-separated on every platform — a Windows `xano\.env` matches nothing and
 * silently leaves a secret un-ignored.
 *
 * AND a guard: a target outside `root`, or `root` itself, has no
 * root-relative spelling worth showing, and the `../../..` that `relative`
 * returns for it is noise at best and a wrong instruction at worst. `""` is the
 * answer for both, so callers can write `relForwardSlash(root, p) || fallback`.
 *
 * `node:path` only — no `node:fs` — so this stays importable from anywhere.
 *
 * `auth/store.ts` carries an older, unguarded twin of this for its own
 * `.gitignore` writing. Its callers all check `startsWith("..")` before
 * reaching it, so it cannot hit the branch that differs; folding it in is a
 * tidy-up for whoever next touches that file, not a correctness fix.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

/** `target` relative to `root` with `/` separators, or `""` when it is not under it. */
export function relForwardSlash(root: string, target: string): string {
  const rel = relative(root, target);
  return rel === "" || rel.startsWith("..") ? "" : rel.split(sep).join("/");
}

/**
 * The directory the user typed the command in, when the run moved to its
 * project's root — set by `setTypedCwd` (emit/typed-cwd.ts), which owns it.
 */
let typedFrom: string | undefined;

/** Kept by `setTypedCwd`; read by {@link displayPath} and `pastePath`. */
export function setPathsShownFrom(dir: string | undefined): void {
  typedFrom = dir;
}

/** The directory printed paths are spelled from, when the run moved away from it. */
export function pathsShownFrom(): string | undefined {
  return typedFrom;
}

/**
 * A path as a message should show it: relative to `root` (the working
 * directory by default) when it is under it, absolute otherwise — never the
 * `../../../../tmp/x` a bare `relative` spells for a file elsewhere.
 *
 * With no `root`, a run that moved to its project's root still spells the path
 * from where the user TYPED (`suites/alpha/xano/xano.lock` from the repository
 * root, `../xano.lock` from `xano/`), as the commands it prints are: a path
 * under the project reads from there, anything else absolute.
 */
export function displayPath(target: string, root?: string): string {
  if (root === undefined && typedFrom !== undefined) {
    const abs = resolve(target);
    const fromTyped = relative(typedFrom, abs).split(sep).join("/");
    if (fromTyped === "") return ".";
    if (!fromTyped.startsWith("..") && !isAbsolute(fromTyped)) return fromTyped;
    return relForwardSlash(process.cwd(), abs) !== "" ? fromTyped : abs;
  }
  return relForwardSlash(root ?? process.cwd(), target) || target;
}
