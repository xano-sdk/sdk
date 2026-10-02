/**
 * The directory the user typed the command in, when the run works from
 * somewhere else: its project's root (`enterProjectRoot`), or the package root
 * an npm script runs at (`npm run xano:check` typed in `frontend/`, read from
 * npm's `INIT_CWD`). A command the run prints is pasted where the user is, so
 * a printed command's paths are spelled from here.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathsShownFrom, setPathsShownFrom } from "../util/rel-path.js";

let base: string | undefined;

/**
 * Set once by the bin when an npm script runs away from where it was typed:
 * the directory a run that does not move itself reports from.
 */
export function setTypedCwdBase(dir: string | undefined): void {
  base = dir;
  setPathsShownFrom(dir);
}

/** Set by `enterProjectRoot` before it moves; back to the base when it moves back. */
export function setTypedCwd(dir: string | undefined): void {
  setPathsShownFrom(dir ?? base);
}

/**
 * A path argument for a command this run PRINTS to be pasted: unchanged when
 * the run did not move, and otherwise re-spelled from where the user typed —
 * `web` found from the root prints as `../web` from `xano/`, so the pasted
 * command resolves it to the same directory. An absolute path stays absolute.
 */
export function pastePath(path: string): string {
  const typed = pathsShownFrom();
  if (typed === undefined || isAbsolute(path)) return path;
  return relative(typed, resolve(path)).split(sep).join("/") || ".";
}
