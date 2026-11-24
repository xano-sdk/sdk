/**
 * A workspace's sites, read, pulled into a project, and served: the work behind
 * `xanosdk site list`, `site pull` and `site serve`, and the same functions
 * `@xano/sdk/node` exports (`listSites`, `pullSites`, `serveBuild`), so Xano
 * Studio calls them in-process and both read a site the same way (DEV-10113).
 *
 * Nothing here prints, prompts or signs in. The caller hands over the target
 * (an instance's base URL, a workspace id and a bearer token), and a confirmation
 * callback when it wants to be asked before anything is written.
 *
 * ── Which build a pull reads ───────────────────────────────────────────────
 *
 * The one the site serves on Dev, where a project works and Studio publishes;
 * else the one Prod serves; else, for a site that serves nothing, its newest
 * build that was built (`env: null`). The build's kept source is read and mapped
 * to an app folder by `deploy/site-source.ts`. A build with no usable source
 * falls back to the files it serves.
 *
 * ── Where it goes ──────────────────────────────────────────────────────────
 *
 * One site into a project with no frontend: the flat layout, `frontend/` is the
 * app, and package.json's site line names it. More than one, or a project that
 * already keeps one app per site: `frontend/<site>/` each (nested), read back by
 * `frontendApps`. A flat project gets only its own site again; another site
 * needs `xanosdk frontend split` first. An app folder that is already there is
 * kept unless `force` replaces it. Nothing outside `frontend/`, the root
 * package.json (its site line, and a built-files app's `dev`/`build` scripts)
 * and `.xano/sites.json` (the build each app was pulled from) is written, and
 * `xano/` is never touched.
 *
 * ── Whether the frontend holds what a site serves ──────────────────────────
 *
 * {@link siteDrift}, which `pull` runs after the backend: for each site the
 * project names, the build Dev serves (else Prod's) is accounted for when its
 * description names a commit in the project's git history, or when it is the
 * build the last site pull here recorded. Anything else is reported, and
 * nothing is changed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { StaticHostBuildRow, StaticHostEnvRow, StaticHostReadTarget, StaticHostRow } from "../deploy/static-host.js";
import type { SiteApp, SiteAppSource } from "../deploy/site-source.js";
import { parseBuildExport, siteAppFromArchive, siteAppFromBuilt, withStaticSiteScripts } from "../deploy/site-source.js";
import { DEFAULT_SITE, FRONTEND_DIR, frontendApps, readStaticHostLine, writeStaticHostLine } from "./frontend-apps.js";
import { recordSitePulls } from "../deploy/site-record.js";

/** Where the site calls go: an instance's base URL, the workspace, and a bearer token for it. */
export type SiteTarget = StaticHostReadTarget;

/* ------------------------------------------------------------------ *
 * listSites
 * ------------------------------------------------------------------ */

/** One environment of a site, as `site list --json` reports it. */
export interface SiteEnvReport {
  /** The address a visitor opens: the custom domain when one is set, else Xano's. Null before anything was published. */
  url: string | null;
  defaultUrl: string | null;
  customUrl: string | null;
  /** The canonical of the build it serves, null when it serves none. */
  canonical: string | null;
  /** That build, when it is among the site's recent builds. */
  build: { id: number | null; name: string | null; description: string | null; createdAt: number | string | null } | null;
}

/** One site, as `site list --json` reports it. */
export interface SiteReport {
  name: string;
  description: string | null;
  /** `one-address` (Dev only), or `dev-and-prod` once Prod has an address or a build. */
  shape: "one-address" | "dev-and-prod";
  dev: SiteEnvReport;
  /** Null for a site with one address. */
  prod: SiteEnvReport | null;
  /** The repository the site builds from, when the platform reports one. */
  repo: string | null;
  /** Whether this project publishes to it (its line, or one of its site folders). */
  project: boolean;
}

/** `site list --json`, and what {@link listSites} returns. */
export interface SiteListReport {
  /** Whose sites: the backend's kind and the name the run printed. */
  backend: { kind: string; label: string };
  /** What the project names: its layout, and the sites it publishes to. */
  project: { layout: "flat" | "nested" | "none"; sites: string[] };
  sites: SiteReport[];
  /** Sites the project names that the backend does not have yet (created on first publish). */
  missing: string[];
}

/** The sites the project publishes to: its folders when nested, else its line (or `default`). */
export function projectSites(
  projectDir: string,
  warn?: (message: string) => void,
): { layout: "flat" | "nested" | "none"; sites: string[] } {
  const layout = frontendApps(projectDir);
  if (layout.layout === "nested") return { layout: "nested", sites: layout.apps.map((a) => a.site) };
  const line = readStaticHostLine(projectDir, warn === undefined ? {} : { warn });
  return { layout: layout.layout, sites: [line ?? DEFAULT_SITE] };
}

/** Prod counts once it has an address or serves a build: a site with only Dev has one address. */
function hasProd(env: StaticHostEnvRow): boolean {
  return env.defaultUrl !== undefined || env.customUrl !== undefined || env.canonical !== undefined;
}

function envReport(env: StaticHostEnvRow, builds: StaticHostBuildRow[] | undefined): SiteEnvReport {
  const build = env.canonical === undefined ? undefined : builds?.find((b) => b.canonical === env.canonical);
  return {
    url: env.customUrl ?? env.defaultUrl ?? null,
    defaultUrl: env.defaultUrl ?? null,
    customUrl: env.customUrl ?? null,
    canonical: env.canonical ?? null,
    build:
      build === undefined
        ? null
        : { id: build.id ?? null, name: build.name ?? null, description: build.description ?? null, createdAt: build.createdAt ?? null },
  };
}

/** Every site of the backend, as reported, with the build each environment serves. */
export async function readSites(target: SiteTarget, named: readonly string[]): Promise<SiteReport[]> {
  const { listStaticHosts, listStaticHostBuilds } = await import("../deploy/static-host.js");
  const rows: StaticHostRow[] = await listStaticHosts(target);
  return Promise.all(
    rows.map(async (row) => {
      const serving = row.dev.canonical !== undefined || row.prod.canonical !== undefined;
      // A build's description says where it came from; one read per site that serves one.
      const builds = serving ? await listStaticHostBuilds(target, row.name).catch(() => undefined) : undefined;
      const prod = hasProd(row.prod);
      return {
        name: row.name,
        description: row.description ?? null,
        shape: prod ? ("dev-and-prod" as const) : ("one-address" as const),
        dev: envReport(row.dev, builds),
        prod: prod ? envReport(row.prod, builds) : null,
        repo: row.repo ?? null,
        project: named.includes(row.name),
      };
    }),
  );
}

/** What {@link listSites} reads. */
export interface ListSitesOptions {
  target: SiteTarget;
  /** The project whose site(s) `project` and `missing` are about. Without it, `project.layout` is `none`. */
  projectDir?: string;
  /** The backend's name in `backend.label` (default `workspace <id>`). */
  label?: string;
}

/**
 * The workspace's sites: the same document `xanosdk site list --json` prints.
 *
 * ```ts
 * import { listSites } from "@xano/sdk/node";
 *
 * const report = await listSites({
 *   target: { baseUrl: "https://x1.xano.io", workspaceId: 12, accessToken },
 *   projectDir: "/path/to/project",
 * });
 * report.sites.map((s) => `${s.name}: ${s.dev.url}`);
 * ```
 *
 * Throws when the sites cannot be read.
 */
export async function listSites(opts: ListSitesOptions): Promise<SiteListReport> {
  const project = opts.projectDir === undefined ? { layout: "none" as const, sites: [] } : projectSites(opts.projectDir);
  const sites = await readSites(opts.target, project.sites);
  return {
    backend: { kind: "workspace", label: opts.label ?? `workspace ${opts.target.workspaceId}` },
    project,
    sites,
    missing: project.sites.filter((s) => !sites.some((site) => site.name === s)),
  };
}

/* ------------------------------------------------------------------ *
 * pullSites
 * ------------------------------------------------------------------ */

/**
 * What a pull does with one site:
 * - `write`: its app is (or was) written to `dir`.
 * - `exists`: `dir` is already there and is kept (`force` replaces it).
 * - `blocked`: the project's `frontend/` is one app for another site, so this
 *   one has nowhere to go until `xanosdk frontend split`.
 * - `no-source`: the build kept no usable source and its files could not be read.
 * - `no-build`: the site serves no build and has none built.
 */
export type SitePullStatus = "write" | "exists" | "blocked" | "no-source" | "no-build";

/** One site of a pull. */
export interface SitePullEntry {
  site: string;
  /** The environment whose build was read; `null` for the newest build of a site that serves none. */
  env: "dev" | "prod" | null;
  /** The build read, when there was one. */
  build: { id: number; name: string | null; description: string | null } | null;
  /** Where its app came from (see {@link SiteAppSource}); `null` when nothing could be read. */
  source: SiteAppSource | null;
  /** `project-app` only: the folder of the kept project the app was taken from. */
  from: string | null;
  /** The app folder, relative to the project and POSIX-separated: `frontend` or `frontend/<site>`. Null when it has nowhere to go. */
  dir: string | null;
  /** How many files the app has. */
  files: number;
  /** Whether it is the built-files shape (`site.mjs` beside `site/`). */
  builtFiles: boolean;
  status: SitePullStatus;
  /** `write` only: whether `dir` is already there and is replaced (`force`). */
  replaces: boolean;
  /** Why it is not plain sailing: a source that could not be used, a fallback taken, a folder kept. */
  note: string | null;
  /** The repository a Git-synced site builds from. */
  repo: string | null;
}

/** What {@link pullSites} planned, and what it did. */
export interface SitePullReport {
  /** The project written into (absolute). */
  projectDir: string;
  /** The layout the pulled apps sit in: `flat` (`frontend/` is the app) or `nested` (`frontend/<site>/`). */
  layout: "flat" | "nested";
  sites: SitePullEntry[];
  /** Whether anything was written: false for a dry run, a declined confirmation, or nothing to write. */
  applied: boolean;
  /** True when the confirmation said no. */
  declined: boolean;
  /** The site line package.json now names (flat only), when this pull wrote it. */
  siteLine: string | null;
  /** Whether package.json gained the `dev`/`build` scripts a flat built-files app runs. */
  scriptsAdded: boolean;
}

/** What {@link pullSites} does. */
export interface PullSitesOptions {
  target: SiteTarget;
  /** The project to write into: its `frontend/` and root `package.json`. */
  projectDir: string;
  /** The sites to pull, by name (default: every site of the workspace). A name it does not have throws {@link SiteNotFoundError}. */
  sites?: readonly string[];
  /** Replace an app folder that is already there (default: keep it, status `exists`). */
  force?: boolean;
  /** Plan only: read everything, write nothing. */
  dryRun?: boolean;
  /**
   * Asked with the plan before anything is written, when there is something to
   * write. `false` writes nothing (`declined: true`). Without it the pull writes.
   */
  confirm?: (plan: SitePullReport) => boolean | Promise<boolean>;
}

/** A site name the workspace does not have. */
export class SiteNotFoundError extends Error {
  override readonly name = "SiteNotFoundError";
  readonly exitCode = 8;
  constructor(
    readonly missing: readonly string[],
    readonly names: readonly string[],
  ) {
    super(
      `The workspace has no site named ${missing.map((n) => `"${n}"`).join(", ")}` +
        (names.length === 0 ? " — it has no sites" : ` — its sites are ${names.map((n) => `"${n}"`).join(", ")}`) +
        ". Nothing was written.",
    );
  }
}

/** The build a pull reads for a site: Dev's, else Prod's, else the newest built one. */
export function servedBuild(
  row: Pick<StaticHostRow, "dev" | "prod">,
  builds: readonly StaticHostBuildRow[],
): { env: "dev" | "prod" | null; build: StaticHostBuildRow } | undefined {
  for (const env of ["dev", "prod"] as const) {
    const canonical = row[env].canonical;
    const build = canonical === undefined ? undefined : builds.find((b) => b.canonical === canonical && b.id !== undefined);
    if (build !== undefined) return { env, build };
  }
  let newest: StaticHostBuildRow | undefined;
  for (const b of builds) {
    if (b.id === undefined || b.status !== "ok") continue;
    if (newest === undefined || b.id > newest.id!) newest = b;
  }
  return newest === undefined ? undefined : { env: null, build: newest };
}

/** A site's app, read from the platform: from its kept source, else from its served files. */
async function readSiteApp(
  target: SiteTarget,
  row: StaticHostRow,
): Promise<Omit<SitePullEntry, "dir" | "status" | "replaces"> & { app: SiteApp | undefined }> {
  const sh = await import("../deploy/static-host.js");
  const { readArchive, ArchiveReadError } = await import("../util/archive-read.js");
  const base = { site: row.name, repo: row.repo ?? null };
  const builds = await sh.listStaticHostBuilds(target, row.name);
  const chosen = servedBuild(row, builds);
  if (chosen === undefined) {
    return {
      ...base,
      env: null,
      build: null,
      source: null,
      from: null,
      files: 0,
      builtFiles: false,
      note: row.repo === undefined ? "it serves no build" : `it serves no build; its code is in ${row.repo}`,
      app: undefined,
    };
  }
  const id = chosen.build.id!;
  const build = { id, name: chosen.build.name ?? null, description: chosen.build.description ?? null };
  const entry = (app: SiteApp | undefined, note: string | null) => ({
    ...base,
    env: chosen.env,
    build,
    source: app?.source ?? null,
    from: app?.from ?? null,
    files: app?.files.length ?? 0,
    builtFiles: app?.builtFiles ?? false,
    note,
    app,
  });

  let why: string;
  const archive = await sh.downloadStaticBuildSource(target, row.name, id);
  if (archive === undefined) why = "no source was kept with the build";
  else {
    try {
      const mapped = siteAppFromArchive(readArchive(archive), row.name);
      if ("app" in mapped) return entry(mapped.app, null);
      why = mapped.reason;
    } catch (err) {
      if (!(err instanceof ArchiveReadError)) throw err;
      why = `its kept source could not be read: ${err.message}`;
    }
  }
  const repo = row.repo === undefined ? "" : `; its code is in ${row.repo}`;
  const text = await sh.exportStaticBuildFiles(target, row.name, id).catch(() => undefined);
  const built = text === undefined ? undefined : siteAppFromBuilt(parseBuildExport(text));
  if (built !== undefined) return entry(built, `${why}, so the files it serves were taken as built files${repo}`);
  return entry(undefined, `${why}, and the files it serves could not be read${repo}`);
}

function isNonEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

/** Read every chosen site and decide where each goes. Writes nothing. */
async function planSitePull(opts: PullSitesOptions): Promise<{ report: SitePullReport; apps: Map<string, SiteApp> }> {
  const { listStaticHosts } = await import("../deploy/static-host.js");
  const projectDir = resolve(opts.projectDir);
  const rows = await listStaticHosts(opts.target);
  const names = rows.map((r) => r.name);
  const wanted = opts.sites === undefined || opts.sites.length === 0 ? names : [...new Set(opts.sites)];
  const missing = wanted.filter((n) => !names.includes(n));
  if (missing.length > 0) throw new SiteNotFoundError(missing, names);
  const chosen = rows.filter((r) => wanted.includes(r.name));

  const read = await Promise.all(chosen.map((row) => readSiteApp(opts.target, row)));
  const apps = new Map<string, SiteApp>();
  for (const r of read) if (r.app !== undefined) apps.set(r.site, r.app);

  const existing = frontendApps(projectDir);
  const frontendRoot = join(projectDir, FRONTEND_DIR);
  const flatSite = existing.layout === "flat" ? existing.apps[0]!.site : undefined;
  const layout: "flat" | "nested" =
    existing.layout === "nested"
      ? "nested"
      : existing.layout === "flat"
        ? "flat"
        : apps.size <= 1 && !isNonEmptyDir(frontendRoot)
          ? "flat"
          : "nested";

  const sites: SitePullEntry[] = read.map(({ app, ...rest }) => {
    const r = { ...rest, replaces: false };
    if (app === undefined) return { ...r, dir: null, status: r.build === null ? "no-build" : "no-source" };
    if (layout === "flat" && flatSite !== undefined && flatSite !== r.site) {
      return {
        ...r,
        dir: null,
        status: "blocked",
        note:
          `${FRONTEND_DIR}/ is one app, publishing to the site "${flatSite}"; \`xanosdk frontend split\` moves it ` +
          `into ${FRONTEND_DIR}/${flatSite}/ so this site can sit beside it`,
      };
    }
    const dir = layout === "flat" ? FRONTEND_DIR : `${FRONTEND_DIR}/${r.site}`;
    const there = isNonEmptyDir(join(projectDir, ...dir.split("/")));
    if (there && opts.force !== true) {
      return { ...r, dir, status: "exists", note: [r.note, `${dir}/ is already there and is kept`].filter((n) => n !== null).join("; ") };
    }
    return { ...r, dir, status: "write", replaces: there };
  });
  // A flat layout holds one app: when two sites would both land in frontend/, only the first is written.
  if (layout === "flat") {
    const writing = sites.filter((s) => s.status === "write" || s.status === "exists");
    for (const extra of writing.slice(1)) {
      extra.status = "blocked";
      extra.dir = null;
      extra.note = `${FRONTEND_DIR}/ holds one app, and "${writing[0]!.site}" takes it`;
    }
  }
  return {
    report: { projectDir, layout, sites, applied: false, declined: false, siteLine: null, scriptsAdded: false },
    apps,
  };
}

/** Write the planned apps. */
function applySitePull(report: SitePullReport, apps: Map<string, SiteApp>): void {
  const root = report.projectDir;
  const frontendRoot = join(root, FRONTEND_DIR);
  for (const entry of report.sites) {
    if (entry.status !== "write" || entry.dir === null) continue;
    const app = apps.get(entry.site)!;
    const dir = join(root, ...entry.dir.split("/"));
    // Only ever under frontend/: never the backend, never the project root.
    if (dir !== frontendRoot && !dir.startsWith(frontendRoot + sep)) throw new Error(`Refusing to write outside ${FRONTEND_DIR}/: ${entry.dir}`);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    for (const file of app.files) {
      const to = resolve(dir, ...file.path.split("/"));
      if (!to.startsWith(dir + sep)) throw new Error(`Refusing to write outside ${entry.dir}/: ${file.path}`);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, file.data);
    }
    if (report.layout === "flat") {
      const line = writeStaticHostLine(root, entry.site);
      if (line.changed) report.siteLine = entry.site;
      if (app.builtFiles) {
        const pkgPath = join(root, "package.json");
        const text = existsSync(pkgPath) ? readFileSync(pkgPath, "utf8") : "{}\n";
        const next = withStaticSiteScripts(text);
        if (next !== null && next !== text) {
          writeFileSync(pkgPath, next);
          report.scriptsAdded = true;
        }
      }
    }
  }
  // Which build each app now holds, for `pull`'s live-build check (see `deploy/site-record.ts`).
  const pulled = report.sites.flatMap((e) =>
    e.status === "write" && e.build !== null ? [{ site: e.site, buildId: e.build.id, env: e.env }] : [],
  );
  if (pulled.length > 0) recordSitePulls(root, pulled);
  report.applied = true;
}

/**
 * Pull the live code of a workspace's sites into a project: the work behind
 * `xanosdk site pull` and `--with-sites`.
 *
 * ```ts
 * import { pullSites } from "@xano/sdk/node";
 *
 * const report = await pullSites({
 *   target: { baseUrl: "https://x1.xano.io", workspaceId: 12, accessToken },
 *   projectDir: "/path/to/project",
 *   confirm: (plan) => plan.sites.every((s) => s.status !== "exists"),
 * });
 * // { layout: "nested", applied: true, sites: [{ site: "shop", status: "write", dir: "frontend/shop", source: "project-app", … }] }
 * ```
 *
 * Reads each site's served build (Dev first, then Prod) and its kept source, and
 * writes each app to its folder (see the module note for the layout rules). A
 * folder already there is kept unless `force`. Throws {@link SiteNotFoundError}
 * for a site name the workspace does not have, and when the sites cannot be read.
 */
export async function pullSites(opts: PullSitesOptions): Promise<SitePullReport> {
  const { report, apps } = await planSitePull(opts);
  if (opts.dryRun === true || !report.sites.some((s) => s.status === "write")) return report;
  if (opts.confirm !== undefined && !(await opts.confirm(structuredClone(report)))) {
    report.declined = true;
    return report;
  }
  applySitePull(report, apps);
  return report;
}

/* ------------------------------------------------------------------ *
 * siteDrift
 * ------------------------------------------------------------------ */

/** A site the project names whose live build its frontend does not hold, as far as the project can tell. */
export interface SiteDrift {
  site: string;
  /** The environment serving the build: Dev, else Prod. */
  env: "dev" | "prod";
  build: { id: number; description: string | null };
  /** The commit the build's description names, when it names one. */
  commit: { sha: string; dirty: boolean } | null;
  /** The site's app folder in this project (relative, POSIX-separated), when it is there. */
  dir: string | null;
}

/**
 * The sites the project names, each with the app folder it keeps for it (if any).
 * A project with no frontend names only the site its line names explicitly.
 */
function namedSiteDirs(projectDir: string): { site: string; dir: string | null }[] {
  const layout = frontendApps(projectDir);
  if (layout.layout === "nested") return layout.apps.map((a) => ({ site: a.site, dir: a.dir }));
  if (layout.layout === "flat") return [{ site: layout.apps[0]!.site, dir: FRONTEND_DIR }];
  const line = readStaticHostLine(projectDir);
  return line === undefined ? [] : [{ site: line, dir: null }];
}

/**
 * The sites the project names whose live build its frontend does not account
 * for: the build Dev serves (else Prod's) is accounted for when it is the one
 * the last site pull here recorded (`.xano/sites.json`), or when its
 * description names a commit in the project's git history with no uncommitted
 * changes. A site the workspace does not have, or one that serves nothing, is
 * left out. Reads only; throws when the sites cannot be read.
 */
export async function siteDrift(target: SiteTarget, projectDir: string): Promise<SiteDrift[]> {
  const named = namedSiteDirs(projectDir);
  if (named.length === 0) return [];
  const sh = await import("../deploy/static-host.js");
  const { readSiteRecords } = await import("../deploy/site-record.js");
  const { buildCommit, commitInHistory } = await import("../deploy/build-provenance.js");
  const rows = await sh.listStaticHosts(target);
  const records = readSiteRecords(projectDir);
  const out: SiteDrift[] = [];
  for (const { site, dir } of named) {
    const row = rows.find((r) => r.name === site);
    if (row === undefined || (row.dev.canonical === undefined && row.prod.canonical === undefined)) continue;
    const builds = await sh.listStaticHostBuilds(target, site);
    const served = servedBuild(row, builds);
    if (served === undefined || served.env === null) continue;
    const id = served.build.id!;
    if (records[site]?.buildId === id) continue;
    const commit = buildCommit(served.build.description);
    if (commit !== undefined && !commit.dirty && commitInHistory(projectDir, commit.sha)) continue;
    out.push({
      site,
      env: served.env,
      build: { id, description: served.build.description ?? null },
      commit: commit ?? null,
      dir: dir !== null && isNonEmptyDir(join(projectDir, ...dir.split("/"))) ? dir : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * serveBuild
 * ------------------------------------------------------------------ */

/** What {@link serveBuild} does. */
export interface ServeBuildOptions {
  target: SiteTarget;
  site: string;
  /** The build to serve, by id (as `site list` and the build list name it). */
  buildId: number;
  env: "dev" | "prod";
}

/** What {@link serveBuild} did. */
export interface ServeBuildResult {
  site: string;
  env: "dev" | "prod";
  buildId: number;
  /** The build's canonical: what the environment now serves. */
  canonical: string | null;
  /** The build it replaced on that environment, when it was among the site's recent builds. */
  previous: { id: number | null; canonical: string } | null;
  /** The address the environment answers at, when the platform says. */
  url: string | null;
}

/** A build the site does not have, or one that cannot be served. */
export class SiteBuildError extends Error {
  override readonly name = "SiteBuildError";
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

/**
 * Serve an existing build of a site on Dev or Prod, as Xano Studio's Promote
 * and Rollback do: no upload, the build is already on the platform.
 *
 * ```ts
 * import { serveBuild } from "@xano/sdk/node";
 *
 * await serveBuild({ target, site: "shop", buildId: 136, env: "prod" });
 * // { site: "shop", env: "prod", buildId: 136, canonical: "sbui-odw1-d341", previous: { id: 114, … }, url: "https://…" }
 * ```
 *
 * Throws {@link SiteNotFoundError} for a site the workspace does not have, and
 * {@link SiteBuildError} for a build it does not have (exit 8) or one that was
 * not built (exit 1).
 */
export async function serveBuild(opts: ServeBuildOptions): Promise<ServeBuildResult> {
  const sh = await import("../deploy/static-host.js");
  const rows = await sh.listStaticHosts(opts.target);
  const row = rows.find((r) => r.name === opts.site);
  if (row === undefined) throw new SiteNotFoundError([opts.site], rows.map((r) => r.name));
  const build = await sh.getStaticHostBuild(opts.target, opts.site, opts.buildId);
  if (build === undefined) {
    throw new SiteBuildError(`The site "${opts.site}" has no build ${opts.buildId}. \`xanosdk site list\` names the builds it serves.`, 8);
  }
  if (build.status !== undefined && build.status !== "ok") {
    throw new SiteBuildError(`Build ${opts.buildId} of the site "${opts.site}" is ${build.status}, not built, so it cannot be served.`, 1);
  }
  const before = row[opts.env].canonical;
  const builds = before === undefined ? [] : await sh.listStaticHostBuilds(opts.target, opts.site).catch(() => []);
  const served = await sh.serveStaticBuild(opts.target, opts.site, opts.buildId, opts.env);
  return {
    site: opts.site,
    env: opts.env,
    buildId: opts.buildId,
    canonical: build.canonical ?? null,
    previous: before === undefined ? null : { id: builds.find((b) => b.canonical === before)?.id ?? null, canonical: before },
    url: served.url ?? row[opts.env].customUrl ?? row[opts.env].defaultUrl ?? null,
  };
}
