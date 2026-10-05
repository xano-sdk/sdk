/**
 * Is there a Xano SDK project here — one answer for every command that says.
 *
 * `status` reported "No Xano SDK project here" in a directory holding only a
 * `package.json`, while `whoami` in the same directory warned that "this
 * project has no xano.profile.json". Both now read this: a backend entry to
 * deploy, or tracked state from an earlier run, at or above the directory, up
 * to the root the profile pin's walk stops at.
 *
 * Node-only; `status` imports it, and the credential path reaches it lazily.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backendDirIn } from "./backend-dir.js";
import { pointerRootFor } from "../auth/profile-pointer.js";
import { setTypedCwd } from "./typed-cwd.js";
import { UsageError } from "./errors.js";
import { shellWord } from "./command-line.js";
import { isHomeRelative } from "../util/home-path.js";

/** A backend entry to deploy, or tracked state from an earlier run. */
export function isProjectDir(cwd: string): boolean {
  return existsSync(join(backendDirIn(cwd), "index.ts")) || existsSync(join(cwd, ".xano"));
}

/**
 * The project `start` sits in: `start` itself or the nearest directory above
 * it holding a backend entry or tracked state, bounded by the same walk the
 * profile pin resolves through — so a command run from `app/xano` finds the
 * project `app/` is, as the pin read from there already does.
 */
export function projectDirFrom(start: string): string | undefined {
  const root = pointerRootFor(start);
  let dir = resolve(start);
  for (;;) {
    if (isProjectDir(dir)) return dir;
    const parent = dirname(dir);
    if (dir === root || parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The parsed path flags a run entered at its project root reads from there —
 * `ParsedArgs` keys, not flag spellings (`--static` parses to `static`,
 * `--backend-env-file` to `envFile`). A test pins this list to every flag the
 * command registry declares as taking a path.
 */
export const RELATIVE_PATH_ARGS = ["out", "lockPath", "entryPath", "static", "bundle", "envFile", "secretsFile", "backendDir", "emit", "path"] as const;

/** Path-valued variables read relative to the working directory, pinned for a run entered at its root. */
const PATH_VARS = ["XANO_CONFIG", "XANO_GLOBAL_CONFIG", "XANO_CLIENT_FILE", "XANOSDK_UPDATE_CACHE", "XANOSDK_PROVE_DIFF", "XANOSDK_ENGINE_HOME", "XANOSDK_ENGINE_OVERRIDE"] as const;

type RootArgs = { [K in (typeof RELATIVE_PATH_ARGS)[number]]?: string | undefined } & {
  argv?: readonly string[] | undefined;
  bundlePositional?: boolean | undefined;
  authFile?: string | undefined;
  localEngineUrl?: string | undefined;
  file?: string | undefined;
  positionals?: string[];
};

/**
 * What the first positional is, for the rebase: `entry` — an entry or bundle
 * path, or a backend name the caller has already ruled out (the run enters the
 * project that PATH is in); `path` — a directory or file always read from
 * where it was typed (`publish <dir>`). Absent, positionals are names and are
 * never touched: `env set NAME <value>` must not have a value rewritten.
 * `verb-path` — the positional AFTER a verb carried in `positionals[0]`
 * (`lock prune <entry>`, `lock import <bundle>`), rebased only when it names
 * something that exists where it was typed, since it may be a lock key instead.
 */
export type PositionalKind = "entry" | "path" | "verb-path";

/** A run moved to its project's root: its arguments read from there, and how to move back. */
export interface EnteredRoot<A> {
  args: A;
  root: string;
  restore: () => void;
}

/**
 * A command that defaults to THIS project's entry (`deploy`, `secrets fill`),
 * run from a directory inside the project, runs at the project root — where
 * `status` finds the project, and where the entry, the lock and the tracked
 * deploy record live. Without it the entry was not found (`missing required
 * <file>`), and a named source's record would have landed in a second `.xano/`
 * beside the subdirectory.
 *
 * Every path typed on the command line is rebased so it still names what it
 * named from the directory it was typed in: relative to the root, or absolute
 * for `--config` (the hints print it absolute anyway). Undefined when `cwd` is
 * the root already, or in no project — a parent project past the nearest
 * `package.json` is never entered (see {@link projectDirFrom}).
 *
 * Throws `SDK_USAGE` when the typed entry belongs to another project than the
 * one `cwd` is in: one run, one project.
 */
export function enterProjectRoot<A extends RootArgs>(
  args: A,
  cwd: string = process.cwd(),
  positional?: PositionalKind,
): EnteredRoot<A> | undefined {
  const here = resolve(cwd);
  const at = positional === "verb-path" ? 1 : 0;
  const first = positional === undefined ? undefined : at === 1 ? args.positionals?.[1] : args.positionals?.[0] ?? args.file;
  // An entry typed on the command line — the positional or `--entry`. A bundle
  // (`deploy ./export.json`) is a file to read, not a project's source.
  const typedEntry =
    positional === "entry" && first !== undefined && first !== "-" && args.bundlePositional !== true ? first : args.entryPath;
  const cwdRoot = projectDirFrom(here);
  // One root per run: the credential (`.xano/auth.json`), the tracked records,
  // the lock default and the landing record all resolve from it. Inside a
  // project, that project is the root, and an entry another project owns is
  // refused — run there, it would land that project's backend on this one's
  // ephemeral and split its lock from its landing record.
  if (cwdRoot !== undefined && typedEntry !== undefined) {
    const owner = entryOwner(resolve(here, typedEntry), cwdRoot);
    if (owner !== undefined && owner !== cwdRoot) throw foreignEntryRefusal(args, here, cwdRoot, owner, typedEntry, first);
  }
  // Outside any project, a typed entry decides it: the project it lies in —
  // `release create --entry=suites/alpha/xano/index.ts` from a repository root
  // holding no project reads the nested project's `.xano/`. One lying in NO
  // project (`deploy /scratch/app.ts`) decides nothing.
  const root = cwdRoot ?? (typedEntry !== undefined ? projectDirFrom(dirname(resolve(here, typedEntry))) : undefined);
  if (root === undefined || root === here) return undefined;
  // A path names what it named where it was typed — unless nothing is there
  // and the same path read from the ROOT names something: that is a command
  // this CLI printed after a run it moved to the root (`--lock=xano/xano.lock`),
  // pasted back from the subdirectory, and it means the root's file.
  const fromRoot = (p: string | undefined): string | undefined => {
    if (p === undefined || p === "-" || isAbsolute(p)) return p;
    if (!existsSync(resolve(here, p)) && existsSync(resolve(root, p))) return p;
    return relative(root, resolve(here, p)) || ".";
  };
  const next: A = { ...args };
  for (const key of RELATIVE_PATH_ARGS) next[key] = fromRoot(args[key]) as A[typeof key];
  if (first !== undefined && (at === 0 || existsSync(resolve(here, first)))) {
    const moved = fromRoot(first);
    if (at === 0 && args.file === first) next.file = moved;
    if (args.positionals !== undefined && args.positionals.length > at) {
      next.positionals = args.positionals.map((p, n) => (n === at ? moved! : p));
    }
  }
  if (args.authFile !== undefined) next.authFile = resolve(here, args.authFile);
  // `--local=<archive>`: a path only when it is not a URL or a version.
  const engine = args.localEngineUrl;
  if (engine !== undefined && isRelativePath(engine)) next.localEngineUrl = fromRoot(engine);
  const saved = PATH_VARS.map((name) => [name, process.env[name]] as const);
  for (const [name, value] of saved) {
    // `~/…` is the home directory wherever the run is entered: its reader expands it.
    if (value !== undefined && !isHomeRelative(value) && isRelativePath(value)) process.env[name] = resolve(here, value);
  }
  setTypedCwd(here);
  process.chdir(root);
  return {
    args: next,
    root,
    restore: () => {
      process.chdir(here);
      setTypedCwd(undefined);
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

/** A directory holding a backend entry of its own (`xano/index.ts`): a project that owns the entries below it. */
function ownsEntries(dir: string): boolean {
  return existsSync(join(backendDirIn(dir), "index.ts"));
}

/**
 * The project an entry belongs to, seen from a run in `cwdRoot`: the nearest
 * directory above it that holds a backend entry of its own, or `cwdRoot` when
 * the walk reaches it first. Undefined for an entry no project owns (a scratch
 * file, or one beside tracked state only — a `.xano/` owns no source).
 */
function entryOwner(entry: string, cwdRoot: string): string | undefined {
  // Through real paths: a symlinked temp or home directory (`/var` → `/private/var`)
  // otherwise reads as another project.
  const root = realDir(cwdRoot);
  let dir = realDir(isDirectory(entry) ? entry : dirname(entry));
  const bound = realDir(pointerRootFor(dir));
  for (;;) {
    if (dir === root) return cwdRoot;
    if (ownsEntries(dir)) return dir;
    const parent = dirname(dir);
    if (dir === bound || parent === dir) return undefined;
    dir = parent;
  }
}

/** `dir` through its real path — its nearest existing ancestor's, for one not there yet. */
function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    const parent = dirname(dir);
    return parent === dir ? dir : join(realDir(parent), basename(dir));
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The refusal for an entry another project owns, with the two ways to run it:
 * in that project, or from a directory that is no project — both spelled from
 * where the user typed, every relative path re-read from the new directory.
 */
function foreignEntryRefusal(
  args: RootArgs,
  here: string,
  cwdRoot: string,
  owner: string,
  typedEntry: string,
  first: string | undefined,
): UsageError {
  // Relative while it stays short (`../beta`), absolute past that.
  const shown = (dir: string): string => {
    const rel = relative(here, dir).split(sep).join("/") || ".";
    return rel.split("/").filter((part) => part === "..").length > 2 ? dir : rel;
  };
  const rerunFrom = (dir: string): string => {
    const rebased = new Map<string, string>();
    for (const value of [typedEntry, first, ...RELATIVE_PATH_ARGS.map((key) => args[key])]) {
      if (value === undefined || value === "-" || isAbsolute(value)) continue;
      rebased.set(value, relative(dir, resolve(here, value)).split(sep).join("/") || ".");
    }
    const words = (args.argv ?? []).map((token) => {
      const whole = rebased.get(token);
      if (whole !== undefined) return whole;
      const eq = token.indexOf("=");
      if (token.startsWith("-") && eq !== -1) {
        const value = rebased.get(token.slice(eq + 1));
        if (value !== undefined) return `${token.slice(0, eq + 1)}${value}`;
      }
      return token;
    });
    return `cd ${shellWord(shown(dir))} && xanosdk ${words.map(shellWord).join(" ")}`;
  };
  // The nearest directory above this project that lies in none: from there the
  // entry's own project is entered.
  let outside: string | undefined = dirname(cwdRoot);
  while (outside !== undefined && projectDirFrom(outside) !== undefined) {
    const parent = dirname(outside);
    outside = parent === outside ? undefined : parent;
  }
  const ways =
    `Run it in that project: \`${rerunFrom(owner)}\`` +
    (outside === undefined || args.argv === undefined ? "." : `, or from a directory outside both: \`${rerunFrom(outside)}\`.`);
  return new UsageError(
    `${typedEntry} belongs to the project at ${owner}, not the one this command runs in (${cwdRoot}). ` +
      `A run uses one project for its credential, tracked backend, lock and landing record, so nothing was run. ${ways}`,
  );
}

/** A relative filesystem path — not a URL, not an engine version, not empty. */
function isRelativePath(value: string): boolean {
  return value !== "" && !isAbsolute(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^v?\d+\.\d+\.\d+$/.test(value);
}
