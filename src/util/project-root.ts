import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * The project root an entry file belongs to.
 *
 * The same upward walk `nearestLockPath` uses, and for the same reason: the env
 * default, the lock default and the secrets-file default must agree about where
 * "the project" is. Stops at the nearest `package.json` so a deploy run from a
 * subdirectory finds the project's own file rather than a parent project's.
 *
 * Lives in `util/` so a module outside the CLI (the hosted-file reader) can use
 * it without importing the command layer; `backend-dir.ts` re-exports it.
 * A second walk of its
 * own would be worse: it would be a second answer to "where is the project",
 * and the env file, the secrets file and the lock have to land in one place or
 * one of them is ignored while the other is not.
 */
export function projectRootFrom(from: string): string {
  const start = resolve(from);
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    // A tree with no `package.json` above it must still be BOUNDED at the repo,
    // the way `pointerRootFor` bounds its own walk. Without this a project whose
    // root carries no manifest resolves the default to `xano/xano/.env` — a path
    // that never exists, so the file would simply never be found.
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** What a {@link repoBoundaryFrom} root is, for a message to name. */
export type RepoBoundaryKind = "repository" | "workspace root" | "project";

/**
 * The outermost directory a project file may reach: the repository a module
 * lives in. A monorepo package (`packages/api`) keeps shared assets at the repo
 * root, so the nearest `package.json` is too narrow a bound.
 *
 * In order: the nearest directory holding `.git`; else the nearest npm/yarn
 * (`package.json` `workspaces`) or pnpm (`pnpm-workspace.yaml`) workspace root
 * whose package globs list the package `from` belongs to; else
 * {@link projectRootFrom} — the nearest `package.json`, the narrowest bound
 * that still names a project.
 */
export function repoBoundaryFrom(from: string): { root: string; kind: RepoBoundaryKind } {
  const start = resolve(from);
  for (let dir = start; ; ) {
    if (existsSync(join(dir, ".git"))) return { root: dir, kind: "repository" };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const project = projectRootFrom(start);
  for (let dir = dirname(project); ; ) {
    const globs = workspaceGlobs(dir);
    if (globs !== undefined && listsPackage(globs, relative(dir, project))) return { root: dir, kind: "workspace root" };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: project, kind: "project" };
}

/** The package globs a workspace root at `dir` declares, if it is one. */
function workspaceGlobs(dir: string): string[] | undefined {
  const pnpm = join(dir, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) {
    const text = readFileSync(pnpm, "utf8");
    const block = /^packages:\s*\n((?:[ \t]+-.*\n?|[ \t]*#.*\n?|[ \t]*\n)*)/m.exec(text)?.[1] ?? "";
    return [...block.matchAll(/^[ \t]+-[ \t]*["']?([^"'\n#]+?)["']?[ \t]*(?:#.*)?$/gm)].map((m) => m[1]!);
  }
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return undefined;
  try {
    const workspaces = (JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: unknown }).workspaces;
    const list = Array.isArray(workspaces) ? workspaces : (workspaces as { packages?: unknown } | undefined)?.packages;
    return Array.isArray(list) ? list.filter((g): g is string => typeof g === "string") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a package at `rel` (relative to the workspace root) is listed: a
 * glob matches it and no negated one (`!packages/legacy`) excludes it.
 */
function listsPackage(globs: readonly string[], rel: string): boolean {
  const path = rel.split(sep).join("/");
  if (path === "" || path.startsWith("..")) return false;
  const matches = (glob: string): boolean => {
    const pattern = glob.replace(/^\.\//, "").replace(/\/+$/, "");
    const source = pattern
      .split("/")
      .map((part) => (part === "**" ? "(?:.+)" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")))
      .join("/");
    return new RegExp(`^${source}$`).test(path);
  };
  const listed = globs.some((glob) => !glob.startsWith("!") && matches(glob));
  return listed && !globs.some((glob) => glob.startsWith("!") && matches(glob.slice(1)));
}
