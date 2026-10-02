/**
 * Which package manager a project installs with.
 *
 * The project's own files decide first: a lockfile, or a `packageManager`
 * field, at the project or any directory above it up to the repository root —
 * a workspace member keeps its lockfile at the workspace root. Running npm in a
 * pnpm or yarn project writes a foreign `package-lock.json` beside the real
 * lockfile and, under pnpm, replaces the linked `node_modules` entry with a
 * copy the next `pnpm install` undoes. Only a directory with none of those
 * falls back to the manager that started this process (`npm_config_user_agent`,
 * as `pnpm dlx` and `yarn dlx` set it), then npm.
 *
 * Node-only; pure apart from reading files.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const MANAGERS: readonly PackageManager[] = ["npm", "pnpm", "yarn", "bun"];

/** The lockfiles and workspace markers that name a manager, most specific first. */
const MARKERS: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["pnpm-workspace.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** The manager a `packageManager` field (`pnpm@9.15.0`) names, if it names one. */
function declaredManager(dir: string): PackageManager | undefined {
  try {
    const field = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { packageManager?: unknown }).packageManager;
    if (typeof field !== "string") return undefined;
    const name = field.split("@")[0];
    return MANAGERS.find((m) => m === name);
  } catch {
    return undefined;
  }
}

/** The manager `npm_config_user_agent` names (`pnpm/9.15.9 npm/? node/v22…`), if any. */
export function userAgentManager(agent: string | undefined): PackageManager | undefined {
  const name = agent?.split("/")[0];
  return MANAGERS.find((m) => m === name);
}

/**
 * Where the project at `dir` installs from: its manager, the directory whose
 * lockfile, workspace marker or `packageManager` field named it (`root`, which
 * is `dir` itself for a standalone project and the workspace root for a
 * member), and whether that manager came from a `packageManager` field.
 *
 * `ignoreWorkspace` is set when the manager is pnpm and a `pnpm-workspace.yaml`
 * above `root` does not list it: pnpm installs the nearest workspace root
 * from anywhere below it, member or not, so this project only installs itself
 * with `--ignore-workspace`.
 */
export interface InstallRoot {
  readonly manager: PackageManager;
  readonly root: string;
  readonly declared: boolean;
  readonly ignoreWorkspace: boolean;
}

/** The POSIX path of `dir` below `root` (`""` for `root` itself). */
function below(root: string, dir: string): string {
  return relative(root, dir).split(sep).join("/");
}

/**
 * {@link detectPackageManager}, with where the answer was found. A directory's
 * own markers count, and an ancestor's only when that ancestor's workspace
 * lists the directory as a member: a stray lockfile in a parent that is not a
 * workspace of this project says nothing about how it installs. A directory
 * with no counting marker up to the repository root installs in place with the
 * manager that started this process: `root` is `dir`.
 */
export function detectInstallRoot(dir: string, env: NodeJS.ProcessEnv = process.env): InstallRoot {
  const self = resolve(dir);
  const found = ((): Omit<InstallRoot, "ignoreWorkspace"> => {
    for (let d = self; ; d = dirname(d)) {
      if (d === self || isWorkspaceMember(d, below(d, self))) {
        const declared = declaredManager(d);
        if (declared !== undefined) return { manager: declared, root: d, declared: true };
        for (const [file, manager] of MARKERS) if (existsSync(join(d, file))) return { manager, root: d, declared: false };
      }
      if (existsSync(join(d, ".git")) || dirname(d) === d) break;
    }
    return { manager: userAgentManager(env.npm_config_user_agent) ?? "npm", root: self, declared: false };
  })();
  return { ...found, ignoreWorkspace: found.manager === "pnpm" && outsidePnpmWorkspace(found.root) };
}

/** Whether the nearest `pnpm-workspace.yaml` above `root` is a workspace that does not list it. */
function outsidePnpmWorkspace(root: string): boolean {
  if (existsSync(join(root, "pnpm-workspace.yaml"))) return false;
  for (let d = dirname(root); ; d = dirname(d)) {
    if (existsSync(join(d, "pnpm-workspace.yaml"))) return !isWorkspaceMember(d, below(d, root));
    if (dirname(d) === d) return false;
  }
}

/**
 * Where to run a command that adds or removes one package of the project at
 * `dir`, and the arguments that aim it at that project. An npm workspace member
 * is changed from the workspace root with `-w <member>` (see
 * {@link npmLockListsMember} for the link it needs first). A project pnpm would
 * otherwise resolve to an enclosing workspace gets `--ignore-workspace`.
 */
export interface InstallSite {
  readonly manager: PackageManager;
  readonly cwd: string;
  readonly scope: readonly string[];
}

export function installSite(dir: string, env: NodeJS.ProcessEnv = process.env): InstallSite {
  const found = detectInstallRoot(dir, env);
  const self = resolve(dir);
  if (found.manager === "npm" && found.root !== self) return { manager: "npm", cwd: found.root, scope: ["-w", below(found.root, self)] };
  return { manager: found.manager, cwd: self, scope: found.ignoreWorkspace ? ["--ignore-workspace"] : [] };
}

/**
 * Whether the npm workspace at `root` has linked `member` (its POSIX path) into
 * its lockfile. Until it has, npm records no package added to that member —
 * neither from inside it nor with `-w` — so the member is linked first.
 */
export function npmLockListsMember(root: string, member: string): boolean {
  try {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages?: Record<string, unknown> };
    return lock.packages !== undefined && member in lock.packages;
  } catch {
    return false;
  }
}

/**
 * The command that installs the project at `dir` as its lockfile has it, run
 * from `dir`: `<manager> install`, plus `--ignore-workspace` where pnpm needs it.
 */
export function installCommandFor(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const found = detectInstallRoot(dir, env);
  return `${found.manager} install${found.ignoreWorkspace ? " --ignore-workspace" : ""}`;
}

/**
 * The package manager for the project at `dir`. Walks up to the repository
 * root (the first directory holding `.git`) or the filesystem root.
 */
export function detectPackageManager(dir: string, env: NodeJS.ProcessEnv = process.env): PackageManager {
  return detectInstallRoot(dir, env).manager;
}

/**
 * The workspace globs `root` declares: `package.json` `workspaces` (an array,
 * or `{ packages }`), and the `packages:` list of `pnpm-workspace.yaml`.
 */
function workspaceGlobs(root: string): string[] {
  const globs: string[] = [];
  try {
    const ws = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces?: unknown }).workspaces;
    const list = Array.isArray(ws) ? ws : (ws as { packages?: unknown } | undefined)?.packages;
    if (Array.isArray(list)) globs.push(...list.filter((g): g is string => typeof g === "string"));
  } catch {
    // No manifest, or not JSON: no `workspaces` to read.
  }
  try {
    globs.push(...yamlSequence(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"), "packages"));
  } catch {
    // No pnpm workspace file.
  }
  return globs;
}

/**
 * The strings of the top-level sequence `key` holds in `yaml`, in either YAML
 * form: block (`key:` then `- item` lines) or flow (`key: [a, "b"]`, which may
 * span lines). Quoted items keep a `#` or `,` inside the quotes; a `#` after
 * whitespace outside them starts a comment.
 */
export function yamlSequence(yaml: string, key: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const at = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (at === -1) return [];
  const inline = stripYamlComment(lines[at]!.slice(key.length + 1)).trim();
  if (inline.startsWith("[")) {
    let flow = inline;
    for (let i = at + 1; !flow.includes("]") && i < lines.length; i++) flow += ` ${stripYamlComment(lines[i]!)}`;
    return splitFlow(flow.slice(1, flow.lastIndexOf("]") === -1 ? undefined : flow.lastIndexOf("]")));
  }
  if (inline !== "") return [];
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const text = stripYamlComment(line);
    if (text.trim() === "") continue;
    if (!/^\s/.test(text) && !text.startsWith("-")) break;
    const item = /^\s*-\s*(.*)$/.exec(text);
    if (item === null) break;
    const value = unquoteYaml(item[1]!.trim());
    if (value !== "") items.push(value);
  }
  return items;
}

/** `line` up to a comment: a `#` at its start or after whitespace, outside quotes. */
function stripYamlComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** The items of a flow sequence's body (`a, "b", 'c'`), split on commas outside quotes. */
function splitFlow(body: string): string[] {
  const items: string[] = [];
  let quote: string | undefined;
  let current = "";
  for (const c of body) {
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  items.push(current);
  return items.map((item) => unquoteYaml(item.trim())).filter((item) => item !== "");
}

/** A YAML scalar with its surrounding quotes taken off. */
function unquoteYaml(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted === null ? value : quoted[2]!;
}

/**
 * The workspace root whose Yarn install is Plug'n'Play, when the project at
 * `dir` installs with one. Yarn 2+ links no `node_modules` in that mode, and
 * the CLI, its modules and the scaffold's build all read packages from there.
 * Decided by `YARN_NODE_LINKER`, else the root's `.yarnrc.yml` `nodeLinker`,
 * else a `.pnp.cjs` already written, else a `packageManager` of Yarn 2 or
 * later, whose default linker is Plug'n'Play.
 */
export function yarnPlugAndPlayRoot(dir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const found = detectInstallRoot(dir, env);
  if (found.manager !== "yarn") return undefined;
  const pnp = (linker: string): string | undefined => (linker === "pnp" ? found.root : undefined);
  if (env.YARN_NODE_LINKER !== undefined && env.YARN_NODE_LINKER !== "") return pnp(env.YARN_NODE_LINKER);
  try {
    const rc = readFileSync(join(found.root, ".yarnrc.yml"), "utf8");
    const linker = /^nodeLinker:\s*["']?([\w-]+)/m.exec(rc)?.[1];
    if (linker !== undefined) return pnp(linker);
  } catch {
    // No .yarnrc.yml: the linker is Yarn's default.
  }
  if (existsSync(join(found.root, ".pnp.cjs"))) return found.root;
  try {
    const field = (JSON.parse(readFileSync(join(found.root, "package.json"), "utf8")) as { packageManager?: unknown }).packageManager;
    const major = typeof field === "string" ? /^yarn@(\d+)/.exec(field)?.[1] : undefined;
    return major !== undefined && Number(major) >= 2 ? found.root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `member` (a POSIX path below `root`) is a package of the workspace
 * `root` declares — the case where the manager installs it from `root` rather
 * than in place. `*` matches one path segment, `**` any number.
 */
export function isWorkspaceMember(root: string, member: string): boolean {
  if (member === "") return false;
  const globs = workspaceGlobs(root);
  const matches = (glob: string): boolean => globToRegExp(glob).test(member);
  const included = globs.filter((g) => !g.startsWith("!")).some(matches);
  return included && !globs.filter((g) => g.startsWith("!")).some((g) => matches(g.slice(1)));
}

/** A workspace glob as a whole-path pattern: `*` one segment's worth, `**` any number of segments. */
function globToRegExp(glob: string): RegExp {
  const segs = glob.replace(/^\.\//, "").replace(/\/+$/, "").split("/");
  let source = "";
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") {
      source += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    source += seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + (last ? "" : "/");
  });
  return new RegExp(`^${source}$`);
}

/** The version `npm_config_user_agent` gives `manager` (`pnpm/9.15.9 …` → `9.15.9`), if it names that manager. */
export function userAgentVersion(agent: string | undefined, manager: PackageManager): string | undefined {
  const [name, version] = (agent?.split(" ")[0] ?? "").split("/");
  return name === manager && version !== undefined && /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
}

/**
 * The command that removes `pkg` from the project at `dir`, run from `dir`
 * (`npm uninstall`, `pnpm remove`, ...).
 */
export function removeCommandFor(dir: string, pkg: string, env: NodeJS.ProcessEnv = process.env): string {
  const found = detectInstallRoot(dir, env);
  return [found.manager, ...removeArgs(found.manager, pkg), ...(found.ignoreWorkspace ? ["--ignore-workspace"] : [])].join(" ");
}

/** The command that adds `spec` to the project at `dir`, run from `dir`. */
export function addCommandFor(dir: string, spec: string, env: NodeJS.ProcessEnv = process.env): string {
  const found = detectInstallRoot(dir, env);
  return [found.manager, ...addArgs(found.manager, spec), ...(found.ignoreWorkspace ? ["--ignore-workspace"] : [])].join(" ");
}

/** The arguments that take `pkg` out of the project: npm's `uninstall`, every other manager's `remove`. */
export function removeArgs(manager: PackageManager, pkg: string): string[] {
  return [manager === "npm" ? "uninstall" : "remove", pkg];
}

/**
 * The arguments that add `spec` to the project in the block it belongs in
 * (`dev`), for `manager`. npm's spelling stays `install`, the one npm's own
 * peer retry is written for.
 */
export function addArgs(manager: PackageManager, spec: string, dev = false): string[] {
  if (manager === "npm") return ["install", spec, ...(dev ? ["--save-dev"] : [])];
  return ["add", spec, ...(dev ? [manager === "pnpm" ? "--save-dev" : "--dev"] : [])];
}
