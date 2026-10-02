/**
 * How the reader runs this CLI, so the commands it prints run as printed.
 *
 * A globally installed `xanosdk` answers to its bare name. Everything else is
 * reached through npx, and what npx resolves depends on WHERE the printed
 * command runs: `npx xanosdk` finds the `xanosdk` bin of a project that has
 * `@xano/sdk` installed (in that directory or above it), and anywhere else
 * asks the registry for a package called `xanosdk`, which is not this one. So a
 * printed command is spelled for the directory it runs in:
 *
 * - global install (or this repository's own build): `xanosdk …`;
 * - under npx, in a directory whose project has `@xano/sdk` installed:
 *   `npx xanosdk …`;
 * - under npx, in a workspace member whose installed bin npx does not search
 *   (see {@link sdkInstalledAt}): `npx --workspaces=false xanosdk …`;
 * - under npx anywhere else: `npx @xano/sdk …`.
 *
 * A command runs where the user typed (`INIT_CWD` for an npm script), or —
 * for `cd <dir> && xanosdk …` — in `<dir>`. The rewrite happens in one place
 * ({@link withCliPrefix}, applied to stderr, help and `--json` documents by the
 * bin) rather than at each of the hundreds of hints that spell one, and touches
 * only command-shaped occurrences: inside backticks, at the start of a line or
 * a string, after a shell operator (`&&`, `|`, `;`, `$(`) or a `label: `.
 *
 * Files written to disk (a scaffold's README, AGENTS.md, xano/EXAMPLE.md) are
 * read inside the project they describe: they spell what npx reaches there
 * ({@link projectFileCli}), independent of how this run was launched.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { COMMANDS } from "./commands.js";
import { setTypedCwdBase } from "./typed-cwd.js";
import type { PackageManager } from "./package-manager.js";

/** The prefix a printed command starts with. */
export type CliPrefix = "xanosdk" | "npx xanosdk" | "npx --workspaces=false xanosdk" | "npx @xano/sdk";

/** How this run was launched: by a name on the PATH, or through npx (a project's install, an npm script, `npx`). */
export type Launcher = "path" | "npx";

export interface InvocationFacts {
  /** The real path of the running bin module. */
  binPath: string;
  /** The working directory the command was typed in. */
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Directories a global install lives under: npm's `<prefix>/lib/node_modules`
 * (Homebrew, nvm, Volta, a system Node), npm on Windows (`%AppData%\npm`), and
 * pnpm's and yarn's global stores.
 */
const GLOBAL_STORES = [
  `${sep}lib${sep}node_modules${sep}`,
  `${sep}npm${sep}node_modules${sep}`,
  `${sep}pnpm${sep}global${sep}`,
  `${sep}yarn${sep}global${sep}`,
];

/**
 * The launcher for a run with these facts:
 *
 * - not under a `node_modules` at all — this repository's own build, or a
 *   linked checkout: `path`, the name its developer has on the PATH;
 * - `npx` / `npm exec` (its cache is `_npx`): `npx`;
 * - installed in a project the command was typed in (`node_modules/.bin`, an
 *   npm script): `npx`;
 * - installed globally: `path`;
 * - anything else (a project's install run from outside it): `npx`.
 */
export function launcherFor(facts: InvocationFacts): Launcher {
  const bin = facts.binPath;
  const marker = `${sep}node_modules${sep}`;
  const at = bin.lastIndexOf(marker);
  if (at === -1) return "path";
  if (bin.includes(`${sep}_npx${sep}`) || facts.env.npm_command === "exec") return "npx";
  const installRoot = bin.slice(0, at);
  const cwd = facts.cwd;
  if (cwd === installRoot || cwd.startsWith(installRoot + sep)) return "npx";
  const store = bin.slice(0, at + marker.length);
  if (GLOBAL_STORES.some((s) => store.endsWith(s) || bin.includes(s))) return "path";
  return "npx";
}

/**
 * The directory a command typed in this run runs from: npm's `INIT_CWD` under
 * an npm script (which runs at the package root, wherever it was typed), the
 * working directory otherwise. `INIT_CWD` counts only for a script of the
 * package in `cwd` — a child process that inherited it from someone else's
 * script was not typed there.
 */
export function typedDirFor(cwd: string, env: NodeJS.ProcessEnv): string {
  const init = env.INIT_CWD;
  if (init === undefined || init === "" || env.npm_lifecycle_event === undefined) return cwd;
  if (env.npm_package_json === undefined || resolve(env.npm_package_json) !== resolve(cwd, "package.json")) return cwd;
  const rel = relative(cwd, init);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? resolve(init) : cwd;
}

/**
 * Whether `@xano/sdk` is installed for a command run in a directory:
 * `true` where `npx xanosdk` finds its bin, `"member-only"` where the bin is
 * installed in the directory's own tree but npx does not search there, `false`
 * where it is not installed at all.
 */
export type SdkInstall = boolean | "member-only";

const installedCache = new Map<string, SdkInstall>();

/** The `node_modules/.bin` holding a `xanosdk` bin, searching `from` and every directory above it. */
function binDirAbove(from: string): string | undefined {
  for (let d = from; ; d = dirname(d)) {
    const bin = join(d, "node_modules", ".bin");
    if (existsSync(join(bin, "xanosdk")) || existsSync(join(bin, "xanosdk.cmd"))) return bin;
    if (dirname(d) === d) return undefined;
  }
}

function readManifest(dir: string): { name?: unknown; workspaces?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown; workspaces?: unknown };
  } catch {
    return undefined;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A `package.json` `workspaces` glob as a whole-path pattern: `*` within one segment, `**` across any number. */
function workspaceGlob(glob: string): RegExp {
  const segs = glob.replace(/^\.\//, "").replace(/\/+$/, "").split("/");
  const source = segs
    .map((seg, i) =>
      seg === "**"
        ? i === segs.length - 1
          ? ".*"
          : "(?:[^/]+/)*"
        : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + (i === segs.length - 1 ? "" : "/"),
    )
    .join("");
  return new RegExp(`^${source}$`);
}

/** Whether the `package.json` `workspaces` of `root` lists the package at `member`. */
function listsWorkspace(root: string, workspaces: unknown, member: string): boolean {
  const list = Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown } | undefined)?.packages;
  if (!Array.isArray(list)) return false;
  const rel = relative(root, member).split(sep).join("/");
  const globs = list.filter((g): g is string => typeof g === "string");
  const hit = (g: string): boolean => workspaceGlob(g).test(rel);
  return globs.some((g) => !g.startsWith("!") && hit(g)) && !globs.some((g) => g.startsWith("!") && hit(g.slice(1)));
}

/**
 * The `node_modules/.bin` that `npx xanosdk` run in `from` takes its bin from.
 *
 * npx searches from its local prefix, not from where it was typed: the nearest
 * directory with a `package.json` or a `node_modules`. When a `package.json`
 * further up lists that directory in its `workspaces`, the prefix becomes that
 * root and npx searches from `<root>/node_modules/<member name>` upward — the
 * link to the member that npm and yarn create, and bun's and pnpm's installs
 * do not. Without that link only the root's own `node_modules/.bin` is
 * searched, so a bin installed in the member is never found.
 */
function npxBinDir(from: string): string | undefined {
  let prefix: string | undefined;
  for (let d = from; prefix === undefined; d = dirname(d)) {
    if (existsSync(join(d, "package.json")) || isDir(join(d, "node_modules"))) prefix = d;
    else if (dirname(d) === d) break;
  }
  if (prefix === undefined) return binDirAbove(from);
  const root = listingWorkspaceRoot(prefix);
  if (root === undefined) return binDirAbove(prefix);
  const name = readManifest(prefix)?.name;
  return binDirAbove(join(root, "node_modules", typeof name === "string" && name !== "" ? name : basename(prefix)));
}

/** The directory above `prefix` whose `package.json` `workspaces` lists it — the root npx treats it as a member of. */
function listingWorkspaceRoot(prefix: string): string | undefined {
  for (let d = dirname(prefix); ; d = dirname(d)) {
    if (existsSync(join(d, "package.json"))) {
      const manifest = readManifest(d);
      if (manifest?.workspaces !== undefined && listsWorkspace(d, manifest.workspaces, prefix)) return d;
    }
    if (dirname(d) === d) return undefined;
  }
}

/** The prefix a file inside a project spells its commands with. */
export type ProjectCli = "npx xanosdk" | "npx --workspaces=false xanosdk";

/**
 * The prefix for commands written into the project at `dir` (its README,
 * AGENTS.md, xano/EXAMPLE.md): what npx run there reaches once the project is
 * installed. npm and yarn link a workspace member under the root's
 * `node_modules`, where npx looks for it; bun and pnpm do not, so in a member
 * of a `package.json` workspace that `manager` installs only
 * `npx --workspaces=false xanosdk` reaches the member's own bin. Decided from
 * the layout rather than the install, so a file written before the install
 * reads the same as one re-rendered after it.
 */
export function projectFileCli(dir: string, manager: PackageManager): ProjectCli {
  if (manager === "npm" || manager === "yarn") return "npx xanosdk";
  return listingWorkspaceRoot(resolve(dir)) === undefined ? "npx xanosdk" : "npx --workspaces=false xanosdk";
}

/** `text` — written with `npx xanosdk` — with each such command spelled `cli`. */
export function spellProjectCli(text: string, cli: ProjectCli | undefined): string {
  return cli === undefined || cli === "npx xanosdk" ? text : text.replace(/\bnpx xanosdk(?=[\s`'")\]]|$)/g, cli);
}

/** Where the project's files say `@xano/sdk` is installed, as written by the templates. */
export const PROJECT_SDK_DIR = "node_modules/@xano/sdk";

/**
 * The POSIX path, from the project at `dir`, of the `@xano/sdk` install its
 * files point an agent at (`llms.txt`, `manifest.json`, the `.d.ts` files).
 * An install already in the project's own `node_modules` wins; otherwise npm
 * and yarn hoist a workspace member's dependencies to the root's
 * `node_modules`, and pnpm and bun link them in the member. Decided from the
 * layout when nothing is installed yet, so a file written before the install
 * reads the same as one re-rendered after it.
 */
export function projectSdkDir(dir: string, manager: PackageManager): string {
  const project = resolve(dir);
  if (existsSync(join(project, PROJECT_SDK_DIR, "package.json"))) return PROJECT_SDK_DIR;
  if (manager !== "npm" && manager !== "yarn") return PROJECT_SDK_DIR;
  const root = listingWorkspaceRoot(project);
  if (root === undefined) return PROJECT_SDK_DIR;
  return `${relative(project, root).split(sep).join("/")}/${PROJECT_SDK_DIR}`;
}

/** `text` — written with `node_modules/@xano/sdk/` paths — with each spelled from `sdkDir`. */
export function spellProjectSdkDir(text: string, sdkDir: string | undefined): string {
  if (sdkDir === undefined || sdkDir === PROJECT_SDK_DIR) return text;
  return text.replace(/(?<![\w./-])node_modules\/@xano\/sdk(?=\/)/g, sdkDir);
}

/**
 * The prefix that runs the `@xano/sdk` installed for `dir` — whatever
 * launched this run: `npx --workspaces=false xanosdk` where npx's workspace
 * lookup misses it ({@link sdkInstalledAt}), `npx xanosdk` otherwise.
 */
export function installedCliAt(dir: string): ProjectCli {
  return sdkInstalledAt(dir) === "member-only" ? "npx --workspaces=false xanosdk" : "npx xanosdk";
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Whether `@xano/sdk` is installed for a command run in `dir`, and whether
 * `npx xanosdk` there reaches that install ({@link SdkInstall}). Only a found
 * install is remembered: an install during this run can turn a miss into a hit.
 */
export function sdkInstalledAt(dir: string): SdkInstall {
  const start = resolve(dir);
  const cached = installedCache.get(start);
  if (cached !== undefined) return cached;
  const own = binDirAbove(start);
  if (own === undefined) return false;
  const npx = npxBinDir(start);
  const found: SdkInstall = npx !== undefined && sameDir(npx, own) ? true : "member-only";
  installedCache.set(start, found);
  return found;
}

export interface PrefixState {
  launcher: Launcher;
  /** Where a printed command without a `cd` runs. */
  typedDir: string;
  installedAt: (dir: string) => SdkInstall;
}

let state: PrefixState | undefined;

/** Set once by the bin. A library caller keeps bare `xanosdk`. */
export function setCliLauncher(launcher: Launcher, typedDir?: string, installedAt: (dir: string) => SdkInstall = sdkInstalledAt): void {
  state = launcher === "path" ? undefined : { launcher, typedDir: typedDir ?? process.cwd(), installedAt };
}

/** The run's typed directory as the bin recorded it — `INIT_CWD` under an npm script. */
export function typedDir(): string {
  return state?.typedDir ?? process.cwd();
}

/**
 * The prefix for a command that runs in `dir` (default: where the user typed):
 * `xanosdk` for a global launch, otherwise `npx xanosdk` where npx finds the
 * installed `@xano/sdk`, `npx --workspaces=false xanosdk` where it is
 * installed but npx's workspace lookup misses it (it then searches from the
 * directory itself, so it runs that install rather than a global one or the
 * registry's unrelated `xanosdk`), and `npx @xano/sdk` where it is not
 * installed.
 */
export function cliPrefixAt(dir?: string, s: PrefixState | undefined = state): CliPrefix {
  if (s === undefined) return "xanosdk";
  const installed = s.installedAt(resolve(s.typedDir, dir ?? "."));
  return installed === true ? "npx xanosdk" : installed === "member-only" ? "npx --workspaces=false xanosdk" : "npx @xano/sdk";
}

let pattern: RegExp | undefined;

/**
 * A bare `xanosdk <command>` — a registered command, a flag, or a `<placeholder>`
 * standing for one (help's `Usage: xanosdk <command>`) — at a command
 * start: the start of the text or a line (after indentation and an optional
 * `$ ` prompt), just inside a backtick, after `&&`, `||`, `|`, `;`, `$(`, `(`,
 * `{ `, the keywords `do`, `then`, `else` and `!` (a printed loop or
 * conditional: `for n in a b; do xanosdk …; done`) or a `label: `, or after an
 * ANSI style code — and past an `env` leading the
 * command with its `-u NAME` / `--unset=NAME` removals, and any `NAME=value `
 * environment assignments (`XANO_WORKSPACE_ID=7 xanosdk …`,
 * `env -u XANO_META_TOKEN xanosdk …`). The boundary is group 1; group 2 is the
 * indentation, prompt, `env` and assignments.
 */
function commandPattern(): RegExp {
  if (pattern !== undefined) return pattern;
  const names = Object.keys(COMMANDS)
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[-]/g, "\\-"));
  pattern = new RegExp(
    `(^|\\n|\`|&& |\\|\\| |\\| |; |\\$\\(|\\( ?|\\{ |(?<![\\w-])(?:do|then|else|!) |\\w: |\\x1b\\[[0-9;]*m)([ \\t]*(?:\\$ )?(?:env (?:(?:-u |--unset[= ])[A-Za-z_][A-Za-z0-9_]* )*)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^'\\n]*'|"[^"\\n]*"|[^\\s\`'"]*) )*)xanosdk (?=(?:${names.join("|")})\\b|--?[a-z]|<[a-z][a-z-]*>)`,
    "g",
  );
  return pattern;
}

/**
 * The directory the last `cd <dir> && ` on the command line before `at`
 * changes to, unquoted — so every command of `cd <dir> && a | xanosdk … &&
 * xanosdk …` is spelled for `<dir>`. A command line starts after a backtick or a
 * line break.
 */
function cdTarget(text: string, at: number): string | undefined {
  const from = Math.max(text.lastIndexOf("`", at - 1), text.lastIndexOf("\n", at - 1)) + 1;
  const m = [...text.slice(from, at).matchAll(/(?:^|\s)cd ('(?:[^']|'\\'')*'|"(?:[^"\\]|\\.)*"|[^\s`'"]+) && /g)].at(-1);
  if (m === undefined) return undefined;
  const word = m[1]!;
  if (word.startsWith("'")) return word.slice(1, -1).replace(/'\\''/g, "'");
  if (word.startsWith('"')) return word.slice(1, -1).replace(/\\(.)/g, "$1");
  return word.startsWith("~/") ? join(homedir(), word.slice(2)) : word;
}

/** `text` with every printed `xanosdk <command>` spelled for where it runs. */
export function withCliPrefix(text: string, s: PrefixState | undefined = state): string {
  if (s === undefined || !text.includes("xanosdk ")) return text;
  return text.replace(commandPattern(), (_whole, boundary: string, indent: string, offset: number) => {
    const dir = boundary === "`" || boundary === "\n" ? undefined : cdTarget(text, offset + boundary.length);
    return `${boundary}${indent}${cliPrefixAt(dir, s)} `;
  });
}

/** `value` with {@link withCliPrefix} applied to every string in it — a `--json` document. */
export function withCliPrefixDeep<T>(value: T, s: PrefixState | undefined = state): T {
  if (s === undefined) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return withCliPrefix(v, s);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * Detect this run's launcher and typed directory, and rewrite stderr — every line of it is the
 * CLI's own prose — and a human stdout (a terminal) to it. A piped stdout
 * carries data (an export, a bundle): only help and the `--json` documents
 * written through `writeJson` are rewritten there.
 */
export function installCliPrefix(binPath: string): void {
  const cwd = process.cwd();
  const launcher = launcherFor({ binPath, cwd, env: process.env });
  const typed = typedDirFor(cwd, process.env);
  // Paths printed by a run an npm script started away from the typed directory read from there.
  if (typed !== cwd) setTypedCwdBase(typed);
  setCliLauncher(launcher, typed);
  if (launcher === "path") return;
  const wrap = (stream: NodeJS.WriteStream): void => {
    const write = stream.write;
    stream.write = function (chunk: unknown, ...rest: unknown[]) {
      const text = typeof chunk === "string" ? withCliPrefix(chunk) : chunk;
      return (write as (...a: unknown[]) => boolean).call(stream, text, ...rest);
    } as typeof stream.write;
  };
  wrap(process.stderr);
  if (process.stdout.isTTY === true) wrap(process.stdout);
}
