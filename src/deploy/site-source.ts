/**
 * A site's kept source, turned into the app folder a project keeps for it
 * (DEV-10113). Pure: it maps files to files and reads nothing.
 *
 * A static build can keep the archive it was published with (`--static-source`),
 * and the Metadata API hands it back. What that archive holds depends on who
 * published:
 *
 * - **A Studio or SDK project** (`package.json` plus `frontend/`, or the backend
 *   entry `xano/index.ts`): the whole project at that commit, backend and every
 *   app. The site's app is `frontend/<site>/` when the project keeps one app per
 *   site, or `frontend/` when it keeps one app that publishes to this site.
 * - **An app** (a top `package.json` with a `dev` or `build` script): kept as it is.
 * - **Plain files** (an `index.html` at the top): the files the site serves.
 *   They become the app's built files: `site/` holds them and `site.mjs` serves
 *   and copies them, the same shape Xano Studio writes when it brings a site in.
 *
 * A build with no kept source falls back to the files it serves, read through
 * the build's export, in the same built-files shape.
 *
 * The rules match Xano Studio's, so a project the CLI pulls and one Studio
 * opens hold the same app folders.
 */
import type { ArchiveFile } from "../util/archive-read.js";

/** Where a pulled site's app came from. */
export type SiteAppSource =
  /** The site's app folder, taken from a whole project archive. */
  | "project-app"
  /** An app archive (its own `package.json` with a `dev` or `build` script), kept as it is. */
  | "app"
  /** Plain files kept with the build, written as the app's built files. */
  | "files"
  /** No source was kept: the files the build serves, written as the app's built files. */
  | "built";

/** A site's app, as files relative to its folder (`frontend/` or `frontend/<site>/`). */
export interface SiteApp {
  source: SiteAppSource;
  /** `project-app` only: the archive folder the app was taken from (`frontend/shop` or `frontend`). */
  from?: string;
  /** Whether it is the built-files shape (`site.mjs` beside `site/`), which needs no install. */
  builtFiles: boolean;
  files: ArchiveFile[];
}

/** What a kept source archive holds, by its files. */
export type SiteSourceKind = "project" | "app" | "files" | "none";

/** The project's site line in an archive's `package.json`, when it names one. */
function archiveSiteLine(packageJson: string | null): string | undefined {
  if (packageJson === null) return undefined;
  try {
    const manifest = JSON.parse(packageJson) as { xanosdk?: Record<string, unknown> };
    const own = manifest.xanosdk?.["@xano/sdk"];
    const value = own !== null && typeof own === "object" ? (own as Record<string, unknown>).staticHost : undefined;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a `package.json` declares a `dev` or `build` script. */
function hasAppScripts(packageJson: string | null): boolean {
  if (packageJson === null) return false;
  try {
    const scripts = (JSON.parse(packageJson) as { scripts?: unknown }).scripts;
    if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) return false;
    return "dev" in scripts || "build" in scripts;
  } catch {
    return false;
  }
}

function packageJsonOf(files: readonly ArchiveFile[]): string | null {
  const pkg = files.find((f) => f.path === "package.json");
  return pkg === undefined ? null : pkg.data.toString("utf8");
}

/** What kind of source an archive's files are. */
export function siteSourceKind(files: readonly ArchiveFile[]): SiteSourceKind {
  const paths = new Set(files.map((f) => f.path));
  const pkg = packageJsonOf(files);
  const frontend = files.some((f) => f.path.startsWith("frontend/"));
  if (paths.has("xano/index.ts") || (pkg !== null && frontend)) return "project";
  if (hasAppScripts(pkg)) return "app";
  return paths.has("index.html") ? "files" : "none";
}

/** Whether the folder `prefix` (ending in `/`) holds an app of its own. */
function standsAlone(paths: ReadonlySet<string>, all: readonly string[], prefix: string): boolean {
  return (
    paths.has(`${prefix}package.json`) ||
    paths.has(`${prefix}index.html`) ||
    (paths.has(`${prefix}site.mjs`) && all.some((p) => p.startsWith(`${prefix}site/`)))
  );
}

/** The nested app folders of a project archive (`frontend/<name>/` that stand alone). */
function nestedAppsOf(paths: ReadonlySet<string>, all: readonly string[]): string[] {
  const names = new Set(all.filter((p) => p.startsWith("frontend/") && p.split("/").length > 2).map((p) => p.split("/")[1]!));
  return [...names].filter((n) => standsAlone(paths, all, `frontend/${n}/`)).sort();
}

/**
 * The site's app from its kept source archive (already read), or why it has
 * none: a project whose `frontend/` holds no app for this site, or files with
 * no `index.html` and no app.
 */
export function siteAppFromArchive(files: readonly ArchiveFile[], site: string): { app: SiteApp } | { reason: string } {
  if (files.length === 0) return { reason: "the kept source is empty" };
  const kind = siteSourceKind(files);
  if (kind === "none") return { reason: "the kept source has no app and no index.html" };
  if (kind === "app") return { app: { source: "app", builtFiles: false, files: [...files] } };
  if (kind === "files") return { app: builtFilesApp("files", files) };

  const all = files.map((f) => f.path);
  const paths = new Set(all);
  const take = (prefix: string): SiteApp => ({
    source: "project-app",
    from: prefix.replace(/\/$/, ""),
    builtFiles: paths.has(`${prefix}site.mjs`) && all.some((p) => p.startsWith(`${prefix}site/`)),
    files: files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), data: f.data })),
  });
  if (standsAlone(paths, all, `frontend/${site}/`)) return { app: take(`frontend/${site}/`) };
  if (standsAlone(paths, all, "frontend/")) {
    // A one-app project: its app is this site's when its line names this site,
    // or names none (it published here because it was told to).
    const line = archiveSiteLine(packageJsonOf(files));
    if (line === undefined || line === site) return { app: take("frontend/") };
    return { reason: `the kept project's one app publishes to the site "${line}", not "${site}"` };
  }
  const nested = nestedAppsOf(paths, all);
  if (nested.length > 0) {
    return { reason: `the kept project has no frontend/${site}/ (its apps are ${nested.map((n) => `frontend/${n}/`).join(", ")})` };
  }
  return { reason: "the kept project has no app under frontend/ that stands on its own" };
}

/** The files a build serves, as its app's built files; `undefined` when there are none. */
export function siteAppFromBuilt(files: readonly ArchiveFile[]): SiteApp | undefined {
  if (files.length === 0) return undefined;
  return builtFilesApp("built", files);
}

/** `files` under `site/`, with the `site.mjs` that serves and copies them. */
function builtFilesApp(source: "files" | "built", files: readonly ArchiveFile[]): SiteApp {
  const script = source === "built" || isBuiltOutput(files.map((f) => f.path)) ? BUILT_PAGES_SCRIPT_TEXT : STATIC_SITE_SCRIPT_TEXT;
  return {
    source,
    builtFiles: true,
    files: [{ path: "site.mjs", data: Buffer.from(script, "utf8") }, ...files.map((f) => ({ path: `site/${f.path}`, data: f.data }))],
  };
}

/**
 * The files a build's export answers with (`…/build/{id}/multidoc?source=built`):
 * documents split by `\n---\n`, each `path: <p>\nencoding: base64\n<data>`. A
 * document whose path is unsafe or missing is left out.
 */
export function parseBuildExport(text: string): ArchiveFile[] {
  if (text.trim() === "") return [];
  const files: ArchiveFile[] = [];
  for (const doc of text.split("\n---\n")) {
    const m = /^path: (.*)\nencoding: (base64|text|utf8)\n([\s\S]*)$/.exec(doc);
    if (m === null) continue;
    const path = m[1]!.trim().replace(/^\/+/, "");
    if (path === "" || path.split("/").some((p) => p === ".." || p === "") || path.includes("\\") || path.includes("\0")) continue;
    const data = m[2] === "base64" ? Buffer.from(m[3]!.replace(/\s+/g, ""), "base64") : Buffer.from(m[3]!, "utf8");
    files.push({ path, data });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The app's built-files script, from the project root, for the root `package.json`'s scripts (flat). */
export const STATIC_SITE_SCRIPT = "frontend/site.mjs";

/**
 * The project's `package.json` with the `dev` and `build` scripts a flat
 * built-files app runs (`node frontend/site.mjs dev|build`), as Xano Studio
 * writes them. Scripts already there are kept. `null` when it is not a JSON object.
 */
export function withStaticSiteScripts(packageJson: string): string | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageJson);
  } catch {
    return null;
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const value = manifest as Record<string, unknown>;
  const scripts = value.scripts;
  const current = scripts !== null && typeof scripts === "object" && !Array.isArray(scripts) ? (scripts as Record<string, unknown>) : {};
  const next = { ...value, scripts: { dev: `node ${STATIC_SITE_SCRIPT} dev`, build: `node ${STATIC_SITE_SCRIPT} build`, ...current } };
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** A bundler's output: hashed scripts or styles under the folders Vite, CRA, Next and Astro use. */
const BUILT_ASSET = /(?:^|\/)(?:assets|static\/(?:js|css)|_next\/static|_astro)\/(?:.*\/)?[^/]+[-.][\w-]{8,}\.(?:m?js|css)$/u;

/** Whether a site's files are a build's output rather than its source: a bundler's hashed assets. */
export function isBuiltOutput(paths: readonly string[]): boolean {
  return paths.some((p) => BUILT_ASSET.test(p));
}

/**
 * The first line of `site.mjs` for files that are the site's code (no build
 * step). Kept word for word as Xano Studio writes it: Studio recognizes the
 * file it can manage by this line.
 */
const STATIC_SITE_SCRIPT_MARKER = "// Studio wrote this when it brought in your live site, which has no build step.";

/** The first line instead when what came in was a build's output: the code was not kept. */
const BUILT_PAGES_SCRIPT_MARKER = "// Studio wrote this when it brought in your live site's built pages; its code wasn't kept.";

/**
 * `site.mjs`: serves `site/` as it is on `PORT` (dev) and copies it to `dist/`
 * unchanged (build), so a site with no build step runs and publishes as it did.
 * Node built-ins only, so it needs no install. Word for word what Xano Studio
 * writes, so either tool can pick the project up.
 */
export const STATIC_SITE_SCRIPT_TEXT = `${STATIC_SITE_SCRIPT_MARKER}
// \`npm run dev\` serves frontend/site as it is; \`npm run build\` copies it to frontend/dist.
// Replace both scripts in package.json when the site gets a real build.
import { cpSync, createReadStream, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "site");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const isFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

if (process.argv[2] === "build") {
  const dist = join(here, "dist");
  rmSync(dist, { recursive: true, force: true });
  cpSync(site, dist, { recursive: true });
} else {
  const port = Number(process.env.PORT) || 5173;
  createServer((request, response) => {
    let pathname = "/";
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    let file = resolve(site, \`.\${pathname}\`);
    if (file !== site && !file.startsWith(site + sep)) {
      response.writeHead(403).end();
      return;
    }
    if (!isFile(file)) file = isFile(join(file, "index.html")) ? join(file, "index.html") : file;
    if (!isFile(file) && isFile(\`\${file}.html\`)) file = \`\${file}.html\`;
    // A path with no file is the app's own route: answer with its page.
    if (!isFile(file)) file = join(site, "index.html");
    response.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(response);
  }).listen(port, "127.0.0.1", () => {
    console.log(\`Serving frontend/site at http://localhost:\${port}/\`);
  });
}
`;

/** {@link STATIC_SITE_SCRIPT_TEXT} for a build's output, whose code was not kept. */
export const BUILT_PAGES_SCRIPT_TEXT = STATIC_SITE_SCRIPT_TEXT.replace(STATIC_SITE_SCRIPT_MARKER, BUILT_PAGES_SCRIPT_MARKER);
