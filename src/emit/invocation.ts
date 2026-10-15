/**
 * How the reader runs this CLI, so the commands it prints run as printed.
 *
 * Every command is spelled `npx @xano/sdk …`, a global install included: run
 * in a project that has `@xano/sdk` installed (its root, a subdirectory, a
 * workspace member under any package manager), npx runs that install; anywhere
 * else it fetches the published SDK. A bare `xanosdk` is never printed to a
 * user — a global one ignores the project's installed version — and neither is
 * `npx xanosdk`, which outside such a project asks the registry for the
 * `xanosdk` placeholder, not this SDK. Only this repository's own build keeps
 * the bare name.
 *
 * The rewrite happens in one place ({@link withCliPrefix}, applied to stderr,
 * help and `--json` documents by the bin) rather than at each of the hundreds
 * of hints that spell one, and touches only command-shaped occurrences: inside
 * backticks, at the start of a line or a string, after a shell operator (`&&`,
 * `|`, `;`, `$(`) or a `label: `.
 *
 * Files written to disk (a scaffold's README, AGENTS.md, xano/EXAMPLE.md) say
 * {@link PROJECT_CLI}, independent of how this run was launched.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { COMMANDS } from "./commands.js";
import { setTypedCwdBase } from "./typed-cwd.js";
import type { PackageManager } from "./package-manager.js";

/** The prefix a printed command starts with. */
export type CliPrefix = "xanosdk" | typeof PROJECT_CLI;

/** How a command is spelled for npx, and in every file written into a project. */
export const PROJECT_CLI = "npx @xano/sdk";

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
 * The launcher for a run with these facts: `path` for a bin outside any
 * `node_modules` — this repository's own build, or a linked checkout, run by
 * its developer; `npx` for every install a user has (npx's cache, a project's
 * `node_modules`, a global store), wherever it was typed.
 */
export function launcherFor(facts: InvocationFacts): Launcher {
  return facts.binPath.includes(`${sep}node_modules${sep}`) ? "npx" : "path";
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

function readManifest(dir: string): { name?: unknown; workspaces?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown; workspaces?: unknown };
  } catch {
    return undefined;
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

/** The directory above `prefix` whose `package.json` `workspaces` lists it — the workspace root it is a member of. */
function listingWorkspaceRoot(prefix: string): string | undefined {
  for (let d = dirname(prefix); ; d = dirname(d)) {
    if (existsSync(join(d, "package.json"))) {
      const manifest = readManifest(d);
      if (manifest?.workspaces !== undefined && listsWorkspace(d, manifest.workspaces, prefix)) return d;
    }
    if (dirname(d) === d) return undefined;
  }
}

/** The server an agent's MCP config declares for the bridge. Not the engine's own name. */
export const MCP_SERVER_NAME = "xano-local";

/** A project file a coding agent reads its MCP servers from. */
export interface McpConfig {
  readonly path: string;
  /** The agent that reads it, as `local mcp` names it. */
  readonly agent: string;
  /** Set for an agent that does not promise to launch the server inside the project. */
  readonly workspaceFolder?: string;
}

/**
 * Where each coding agent reads a project's MCP servers: what `init` writes and
 * `local mcp` prints. Claude Code launches a project's server inside the
 * project; Cursor does not promise to, so its config names the project by
 * Cursor's own workspace-folder variable.
 */
export const MCP_CONFIGS: readonly McpConfig[] = [
  { path: ".mcp.json", agent: "Claude Code" },
  { path: ".cursor/mcp.json", agent: "Cursor", workspaceFolder: "${workspaceFolder}" },
];

/** How an agent's MCP config launches the bridge: a program and its arguments. */
export interface McpServerCommand {
  command: string;
  args: string[];
}

/**
 * The command an agent's MCP config runs to reach this project's Xano Engine —
 * `xanosdk local mcp --stdio`, with no url or token in it (the bridge looks
 * both up when it runs).
 *
 * The agent launches it, often before anyone has run `npm install` (a fresh
 * clone opened in an editor), so it must not depend on `node_modules`:
 * {@link PROJECT_CLI} runs the project's own install when there is one, and
 * otherwise fetches the SDK into npx's cache. `--yes` answers npx's install
 * prompt, which an agent has no terminal to answer. The spec carries no
 * version range: `cmd /c` would read the `>` of one as a redirect.
 *
 * An argv rather than a string, so nothing re-splits it. Native Windows
 * launches npx through `cmd /c`, since `npx` there is a script, not an
 * executable.
 *
 * `workspaceFolder` is for an agent that does not promise to launch the server
 * inside the project (Cursor), spelled as that agent's own variable: the
 * bridge is pointed at the project with `--project`. npx resolves the package
 * from where it was launched, so outside the project it runs the published SDK,
 * which serves the same bridge.
 */
export function mcpServerCommand(opts: { platform?: NodeJS.Platform; workspaceFolder?: string } = {}): McpServerCommand {
  const folder = opts.workspaceFolder;
  const npx = ["npx", "--yes", "@xano/sdk", "local", "mcp", "--stdio", ...(folder === undefined ? [] : ["--project", folder])];
  return (opts.platform ?? process.platform) === "win32"
    ? { command: "cmd", args: ["/c", ...npx] }
    : { command: npx[0]!, args: npx.slice(1) };
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

export interface PrefixState {
  launcher: Launcher;
  /** Where a printed command without a `cd` runs. */
  typedDir: string;
}

let state: PrefixState | undefined;

/** Set once by the bin. A library caller keeps bare `xanosdk`. */
export function setCliLauncher(launcher: Launcher, typedDir?: string): void {
  state = launcher === "path" ? undefined : { launcher, typedDir: typedDir ?? process.cwd() };
}

/** The run's typed directory as the bin recorded it — `INIT_CWD` under an npm script. */
export function typedDir(): string {
  return state?.typedDir ?? process.cwd();
}

/** The prefix a printed command starts with: {@link PROJECT_CLI}, or bare `xanosdk` for this repository's own build and a library caller. */
export function cliPrefix(s: PrefixState | undefined = state): CliPrefix {
  return s === undefined ? "xanosdk" : PROJECT_CLI;
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

/** `text` with every printed `xanosdk <command>` spelled as this run's reader runs it. */
export function withCliPrefix(text: string, s: PrefixState | undefined = state): string {
  if (s === undefined || !text.includes("xanosdk ")) return text;
  return text.replace(commandPattern(), (_whole, boundary: string, indent: string) => `${boundary}${indent}${cliPrefix(s)} `);
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
