/**
 * `xanosdk site list` and `xanosdk site use <name>` (DEV-10042) — the sites
 * (static hosts) a frontend publishes to, and the one this project names.
 *
 * A site is a workspace's: it has an address per environment (Dev always,
 * Prod once someone adds it in Xano), and each environment serves one build.
 * The project names its site in package.json (`"xanosdk"."@xano/sdk"
 * ."staticHost"`, see `frontend-apps.ts`); `site use` writes that line, and
 * `publish` / `deploy --static` read it. A project whose frontend holds one
 * app per site (`frontend/<site>/`) names its sites by folder instead.
 *
 * Both verbs read the workspace the credential names unless `--on` names
 * another backend.
 *
 * Node-only (fetch + OAuth + fs); lazily imported by the dispatcher.
 */
import type { ParsedArgs } from "./cli.js";
import { getAccessToken } from "../auth/token.js";
import { requireBackendSlot } from "./backend-slot.js";
import { resolveBackend } from "./tracked-backend.js";
import type { ResolveDeps, ResolvedSource } from "./source-resolve.js";
import { describeBackend } from "./source-resolve.js";
import { unknownSubcommand, UsageError } from "./errors.js";
import { isMachineOutput, writeJson } from "./output.js";
import { detail, info, step, success, warn } from "./ui.js";
import {
  DEFAULT_SITE,
  FRONTEND_DIR,
  frontendApps,
  isSiteName,
  readStaticHostLine,
  writeStaticHostLine,
} from "./frontend-apps.js";
import type { StaticHostBuildRow, StaticHostEnvRow, StaticHostReadTarget, StaticHostRow } from "../deploy/static-host.js";

/** Seams the tests replace; production callers pass nothing. */
export interface SiteCommandOptions {
  deps?: ResolveDeps;
}

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

/** `site list --json`. */
export interface SiteListReport {
  /** Whose sites: the backend's kind and the name the run printed. */
  backend: { kind: string; label: string };
  /** What the project names: its layout, and the sites it publishes to. */
  project: { layout: "flat" | "nested" | "none"; sites: string[] };
  sites: SiteReport[];
  /** Sites the project names that the backend does not have yet (created on first publish). */
  missing: string[];
}

export async function runSiteCommand(args: ParsedArgs, opts: SiteCommandOptions = {}): Promise<void> {
  if (args.subcommand === "list") return runSiteList(args, opts);
  if (args.subcommand === "use") return runSiteUse(args, opts);
  throw unknownSubcommand("site", args.subcommand);
}

/** The backend whose sites are read: `--on`, else the workspace. */
async function siteBackend(args: ParsedArgs, verb: "list" | "use", opts: SiteCommandOptions): Promise<ResolvedSource> {
  const slot = requireBackendSlot("site", verb, "on");
  return resolveBackend(slot, args.on ?? "workspace", {
    credential: () => getAccessToken(args),
    profile: args.profile,
    ...(opts.deps === undefined ? {} : { deps: opts.deps }),
  });
}

function readTarget(resolved: ResolvedSource): StaticHostReadTarget {
  return { baseUrl: resolved.target.base, workspaceId: resolved.target.workspaceId, accessToken: resolved.bearer.access_token };
}

/** The sites the project publishes to: its folders when nested, else its line (or `default`). */
function projectSites(cwd: string): { layout: "flat" | "nested" | "none"; sites: string[] } {
  const layout = frontendApps(cwd);
  if (layout.layout === "nested") return { layout: "nested", sites: layout.apps.map((a) => a.site) };
  const line = readStaticHostLine(cwd, { warn: (m) => warn(m, "static.site-line-ignored") });
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
export async function readSites(target: StaticHostReadTarget, named: readonly string[]): Promise<SiteReport[]> {
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

/** One environment's line: its address and the build it serves. */
function envLine(label: string, env: SiteEnvReport): string {
  const where = env.url ?? "not published yet";
  const build =
    env.canonical === null
      ? ""
      : env.build?.description !== null && env.build?.description !== undefined
        ? ` — ${env.build.description}`
        : ` — build ${env.canonical}`;
  return `${label}${where}${build}`;
}

async function runSiteList(args: ParsedArgs, opts: SiteCommandOptions): Promise<void> {
  const cwd = process.cwd();
  const project = projectSites(cwd);
  const resolved = await siteBackend(args, "list", opts);
  const named = describeBackend(resolved);
  const sites = await readSites(readTarget(resolved), project.sites);
  const missing = project.sites.filter((s) => !sites.some((site) => site.name === s));
  if (isMachineOutput(args)) {
    const report: SiteListReport = {
      backend: { kind: resolved.kind, label: resolved.target.label },
      project,
      sites,
      missing,
    };
    writeJson(report);
    return;
  }
  step(`Sites on ${named}`);
  if (sites.length === 0) detail("None yet: the first publish creates one.");
  for (const site of sites) {
    const tags = [site.shape === "dev-and-prod" ? "Dev and Prod" : "one address", ...(site.project ? ["this project's"] : [])];
    info(`${site.name} (${tags.join(", ")})`);
    if (site.prod === null) detail(envLine("", site.dev));
    else {
      detail(envLine("Dev:  ", site.dev));
      detail(envLine("Prod: ", site.prod));
    }
    if (site.repo !== null) detail(`Repository: ${site.repo}`);
  }
  for (const name of missing) {
    info(`${name} (this project's — not on ${named} yet; the first publish creates it)`);
  }
}

async function runSiteUse(args: ParsedArgs, opts: SiteCommandOptions): Promise<void> {
  const hint = { hintFor: { command: "site", subcommand: "use" } };
  const name = args.positionals[0];
  if (name === undefined || name === "") {
    throw new UsageError("`xanosdk site use` needs the site's name, e.g. `xanosdk site use shop`.", {
      helpFor: { command: "site", subcommand: "use" },
    });
  }
  if (!isSiteName(name)) {
    throw new UsageError(`"${name}" is not a site name: lowercase letters and digits only, like "default" or "shop".`, hint);
  }
  const cwd = process.cwd();
  const layout = frontendApps(cwd);
  if (layout.layout === "nested") {
    throw new UsageError(
      `This project's frontend holds one app per site (${layout.apps.map((a) => a.dir).join(", ")}), and each publishes ` +
        `to the site its folder is named for, so package.json names none. Add ${FRONTEND_DIR}/${name}/ for a site "${name}".`,
      hint,
    );
  }
  const resolved = await siteBackend(args, "use", opts);
  const target = readTarget(resolved);
  const named = describeBackend(resolved);
  const { listStaticHostNames, createStaticHost, StaticHostNotFoundError } = await import("../deploy/static-host.js");
  const names = await listStaticHostNames(target);
  let created = false;
  if (!names.includes(name)) {
    if (args.create !== true) {
      const err = new StaticHostNotFoundError(name, names, "package.json was not changed.");
      err.message =
        `No site named "${name}" on ${named}` +
        (names.length === 0 ? "" : ` — its sites are ${names.map((n) => `"${n}"`).join(", ")}`) +
        `. Add \`--create\` to create it, or name one it has. package.json was not changed.`;
      throw err;
    }
    await createStaticHost(target, name);
    created = true;
  }
  const wrote = writeStaticHostLine(cwd, name);
  if (isMachineOutput(args)) {
    writeJson({ site: name, created, changed: wrote.changed, path: wrote.path });
    return;
  }
  if (created) success(`Created the site "${name}" on ${named}`);
  if (wrote.changed) success(`This project now publishes to "${name}" (${wrote.path})`);
  else info(`This project already publishes to "${name}".`);
  detail("`xanosdk publish` and `deploy --static` publish there unless `--static-host` names another.");
}
