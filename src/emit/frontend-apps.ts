/**
 * Which site(s) a project's frontend publishes to, read from the project
 * itself rather than from any one tool's settings (DEV-10042).
 *
 * ── The line ────────────────────────────────────────────────────────────────
 *
 *     "xanosdk": {
 *       "@xano/sdk": { "engine": "v0.2.17", "staticHost": "another" }
 *     }
 *
 * The SDK's own entry in the project's `"xanosdk"` block, beside the engine
 * pin (`src/deploy/local-engine-pin.ts`). Committed with the project, so every
 * checkout — a teammate's, a fresh Xano Studio, CI, the CLI — publishes to the
 * same site. It is the default `--static-host` for `deploy --static` and
 * `publish`; an explicit `--static-host` still wins. `xanosdk site use <name>`
 * writes it.
 *
 * ── The two layouts ─────────────────────────────────────────────────────────
 *
 * FLAT (one app, today's layout, first-class forever): `frontend/` itself
 * holds the app. It does when it has an `index.html`, a `package.json`, a
 * `src/` folder (the SDK's own SvelteKit scaffold keeps its app there and has
 * no `index.html`), or the built-files layout Xano Studio writes for a site
 * that has no build (`frontend/site.mjs` beside `frontend/site/`). The app
 * publishes to the line's site, else `default`.
 *
 * NESTED (one app per site): `frontend/` has no app of its own, and some of its
 * subfolders do — an own `package.json` with a `build` script, an `index.html`,
 * or the built-files layout — and are named like a site (lowercase letters and
 * digits, as the platform stores a site name). Each such folder publishes to
 * the site it is named for. Any other subfolder (`shared/`, `lib/`) is code the
 * apps share and is never published; so are `dist/`, `build/` and `out/`, the
 * names a build writes to, which are never read as an app.
 *
 * Pure apart from reading files: no process is run, nothing is written except
 * by {@link writeStaticHostLine}. Exported from `@xano/sdk/node` so Xano Studio
 * and the CLI read a project the same way (`xanosdk frontend list --json`
 * prints {@link frontendApps}).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  composeToolchainConfig,
  readProjectManifest,
  readToolchainBlock,
  SDK_PACKAGE,
  writeToolchainConfig,
} from "./project-config.js";

/** The field under the SDK's own entry that names the project's site. */
export const STATIC_HOST_FIELD = "staticHost";

/** The site a frontend publishes to when nothing names one. */
export const DEFAULT_SITE = "default";

/** The folder, under the project root, that holds the frontend. */
export const FRONTEND_DIR = "frontend";

/**
 * A site's name as the platform stores it: lowercase letters and digits only
 * (the static-host name field keeps nothing else). Capped well under a DNS
 * label, since a site's address is built from it.
 */
const SITE_NAME = /^[a-z0-9]{1,48}$/;

/** Whether `value` is a name a site can have. */
export function isSiteName(value: unknown): value is string {
  return typeof value === "string" && SITE_NAME.test(value);
}

/** Folders a build writes to: never an app of their own, whatever they hold. */
const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set(["dist", "build", "out"]);

/** How a nested app is turned into the files a site serves. */
export type FrontendAppBuild =
  /** Its own `package.json` has a `build` script: run it, publish its output. */
  | "script"
  /** Its files are served as they are (an `index.html` and no build script). */
  | "none"
  /** Xano Studio's built-files layout: `site.mjs` beside `site/`, which is served as it is. */
  | "built-files";

/** One app the project's frontend holds, and the site it publishes to. */
export interface FrontendApp {
  /** The app's folder, relative to the project root, POSIX-separated: `frontend` or `frontend/shop`. */
  dir: string;
  /** The site it publishes to: the folder's name when nested, else the line's site or `default`. */
  site: string;
  /** Nested apps only: how it is built before it is published (see {@link FrontendAppBuild}). */
  build?: FrontendAppBuild;
}

/** What {@link frontendApps} found. */
export interface FrontendApps {
  /**
   * `flat`: `frontend/` is one app. `nested`: one app per site folder.
   * `none`: no `frontend/`, or one holding no app.
   */
  layout: "flat" | "nested" | "none";
  /** The apps, one per site. Empty for `none`; exactly one for `flat`; sorted by folder for `nested`. */
  apps: FrontendApp[];
  /** Nested only: subfolders that hold no app (shared code), relative to the project root. */
  shared?: string[];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The `build` script `dir/package.json` declares, when it declares one. */
function hasBuildScript(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: unknown };
    const scripts = pkg.scripts;
    return (
      typeof scripts === "object" &&
      scripts !== null &&
      typeof (scripts as Record<string, unknown>).build === "string" &&
      ((scripts as Record<string, string>).build ?? "").trim() !== ""
    );
  } catch {
    return false;
  }
}

/** Xano Studio's layout for a site's built files: `site.mjs` serves and copies `site/`. */
function isBuiltFilesLayout(dir: string): boolean {
  return isFile(join(dir, "site.mjs")) && isDir(join(dir, "site"));
}

/** Whether `frontend/` itself holds an app — the flat layout. */
function holdsAppItself(dir: string): boolean {
  return (
    isFile(join(dir, "index.html")) ||
    isFile(join(dir, "package.json")) ||
    isDir(join(dir, "src")) ||
    isBuiltFilesLayout(dir)
  );
}

/** How a subfolder of a nested `frontend/` is built, or `undefined` when it holds no app. */
function nestedAppBuild(dir: string): FrontendAppBuild | undefined {
  if (hasBuildScript(dir)) return "script";
  if (isBuiltFilesLayout(dir)) return "built-files";
  if (isFile(join(dir, "index.html"))) return "none";
  return undefined;
}

/** What {@link readStaticHostLine} found, with why a present value was ignored. */
export interface StaticHostLineRead {
  /** The site the line names, when it names a usable one. */
  site: string | undefined;
  /** Set when a line is present but unusable: the value as stored, for the warning. */
  ignored?: { value: unknown };
}

/**
 * The project's site line, read without side effects. A value that is not a
 * site name (`"My Site"`, `5`) is reported in `ignored` and reads as unset —
 * the project then publishes to `default`, as one without a line does.
 */
export function readStaticHostLineDetail(projectDir: string): StaticHostLineRead {
  const manifest = readProjectManifest(projectDir);
  if (manifest === null) return { site: undefined };
  const own = readToolchainBlock(projectDir, manifest)[SDK_PACKAGE];
  if (typeof own !== "object" || own === null || Array.isArray(own)) return { site: undefined };
  if (!(STATIC_HOST_FIELD in own)) return { site: undefined };
  const value = (own as Record<string, unknown>)[STATIC_HOST_FIELD];
  if (isSiteName(value)) return { site: value };
  return { site: undefined, ignored: { value } };
}

/**
 * The site the project names in its `package.json`, or `undefined` when it
 * names none. A value that is not a site name is ignored, and `warn` (when
 * given) is told why.
 */
export function readStaticHostLine(projectDir: string, opts: { warn?: (message: string) => void } = {}): string | undefined {
  const read = readStaticHostLineDetail(projectDir);
  if (read.ignored !== undefined) {
    opts.warn?.(
      `The "${STATIC_HOST_FIELD}" setting under "xanosdk"."${SDK_PACKAGE}" in ${join(projectDir, "package.json")} is ` +
        `${JSON.stringify(read.ignored.value)}, not a site name (lowercase letters and digits), so it was ignored ` +
        `and the frontend publishes to "${DEFAULT_SITE}". \`xanosdk site use <name>\` writes a valid one.`,
    );
  }
  return read.site;
}

/** What {@link writeStaticHostLine} did. */
export interface WriteStaticHostLineResult {
  /** Whether `package.json` was rewritten. False when it already said this. */
  changed: boolean;
  /** Whether there was no `package.json`, so one holding only the line was created. */
  created: boolean;
  /** The manifest the line lives in. */
  path: string;
}

/**
 * Write the site line, merging into the existing `"xanosdk"` block as the
 * engine pin does: every other package's settings, and every other setting
 * under the SDK's own entry, are kept as they are. `undefined` removes the
 * line (and the SDK's entry with it, when that was all it held). Throws on a
 * value that is not a site name.
 */
export function writeStaticHostLine(projectDir: string, site: string | undefined): WriteStaticHostLineResult {
  if (site !== undefined && !isSiteName(site)) {
    throw new Error(`"${site}" is not a site name: lowercase letters and digits only, like "default" or "shop".`);
  }
  const path = join(projectDir, "package.json");
  if (!existsSync(path)) {
    if (site === undefined) return { changed: false, created: false, path };
    const text = composeToolchainConfig("{}\n", { [SDK_PACKAGE]: { [STATIC_HOST_FIELD]: site } });
    try {
      writeFileSync(path, text, { flag: "wx" });
      return { changed: true, created: true, path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  const block = readToolchainBlock(projectDir);
  const own = block[SDK_PACKAGE];
  const ownSettings = typeof own === "object" && own !== null && !Array.isArray(own) ? { ...(own as Record<string, unknown>) } : {};
  if (site === undefined) delete ownSettings[STATIC_HOST_FIELD];
  else ownSettings[STATIC_HOST_FIELD] = site;
  const next: Record<string, unknown> = { ...block };
  if (Object.keys(ownSettings).length === 0) delete next[SDK_PACKAGE];
  else next[SDK_PACKAGE] = ownSettings;
  const changed = writeToolchainConfig(projectDir, next);
  return { changed, created: false, path };
}

/**
 * The apps the project's frontend holds, and the site each publishes to.
 *
 * ```ts
 * import { frontendApps } from "@xano/sdk/node";
 *
 * frontendApps("/path/to/project");
 * // flat:   { layout: "flat", apps: [{ dir: "frontend", site: "default" }] }
 * // nested: { layout: "nested", apps: [{ dir: "frontend/admin", site: "admin", build: "script" },
 * //                                    { dir: "frontend/shop", site: "shop", build: "none" }],
 * //           shared: ["frontend/shared"] }
 * ```
 *
 * A flat app's site is the project's line ({@link STATIC_HOST_FIELD}), else
 * `default`; a line that is not a site name reads as unset here, silently
 * (`readStaticHostLine` is the reader that warns). A nested app's site is its
 * folder's name, and the line plays no part. Never throws on a missing or
 * unreadable folder: it answers `none`.
 */
export function frontendApps(projectDir: string): FrontendApps {
  const root = join(projectDir, FRONTEND_DIR);
  if (!isDir(root)) return { layout: "none", apps: [] };
  if (holdsAppItself(root)) {
    return {
      layout: "flat",
      apps: [{ dir: FRONTEND_DIR, site: readStaticHostLineDetail(projectDir).site ?? DEFAULT_SITE }],
    };
  }
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(join(root, e.name))))
      .map((e) => e.name)
      .sort();
  } catch {
    return { layout: "none", apps: [] };
  }
  const apps: FrontendApp[] = [];
  const shared: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const dir = `${FRONTEND_DIR}/${name}`;
    const build = isSiteName(name) && !BUILD_OUTPUT_DIRS.has(name) ? nestedAppBuild(join(root, name)) : undefined;
    if (build === undefined) shared.push(dir);
    else apps.push({ dir, site: name, build });
  }
  if (apps.length === 0) return { layout: "none", apps: [] };
  return { layout: "nested", apps, shared };
}
