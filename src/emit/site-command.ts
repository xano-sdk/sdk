/**
 * `xanosdk site list` and `xanosdk site use <name>` (DEV-10042) — the sites
 * (static hosts) a frontend publishes to, and the one this project names —
 * plus `site pull [site…]`, which brings each site's live code into
 * `frontend/`, and `site serve <site> <build> --env dev|prod`, which puts an
 * existing build on an environment (DEV-10113; the work is in `sites-api.ts`).
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
import { relative, sep } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken } from "../auth/token.js";
import { requireBackendSlot } from "./backend-slot.js";
import { resolveBackend } from "./tracked-backend.js";
import type { ResolveDeps, ResolvedSource } from "./source-resolve.js";
import { describeBackend } from "./source-resolve.js";
import { unknownSubcommand, UsageError } from "./errors.js";
import { isMachineOutput, writeJson } from "./output.js";
import { detail, info, step, success, warn } from "./ui.js";
import { FRONTEND_DIR, frontendApps, isSiteName, writeStaticHostLine } from "./frontend-apps.js";
import type { StaticHostReadTarget } from "../deploy/static-host.js";
import { projectSites, readSites } from "./sites-api.js";
import type { SiteDrift, SiteEnvReport, SiteListReport, SitePullEntry, SitePullReport } from "./sites-api.js";

/** Seams the tests replace; production callers pass nothing. */
export interface SiteCommandOptions {
  deps?: ResolveDeps;
}

export type { SiteEnvReport, SiteListReport, SiteReport } from "./sites-api.js";

export async function runSiteCommand(args: ParsedArgs, opts: SiteCommandOptions = {}): Promise<void> {
  if (args.subcommand === "list") return runSiteList(args, opts);
  if (args.subcommand === "use") return runSiteUse(args, opts);
  if (args.subcommand === "pull") return runSitePull(args, opts);
  if (args.subcommand === "serve") return runSiteServe(args, opts);
  throw unknownSubcommand("site", args.subcommand);
}

/** The backend whose sites are read: `--on`, else the workspace. */
async function siteBackend(args: ParsedArgs, verb: "list" | "use" | "pull" | "serve", opts: SiteCommandOptions): Promise<ResolvedSource> {
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
  const project = projectSites(cwd, (m) => warn(m, "static.site-line-ignored"));
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

/* ------------------------------------------------------------------ *
 * site pull (and --with-sites)
 * ------------------------------------------------------------------ */

/** Where the build a pull read came from, in words: `Dev, build 136 — Published from …`. */
function buildWords(entry: SitePullEntry): string {
  if (entry.build === null) return "no build";
  const env = entry.env === "dev" ? "Dev, " : entry.env === "prod" ? "Prod, " : "newest, served nowhere: ";
  const said = entry.build.description ?? entry.build.name;
  return `${env}build ${entry.build.id}${said === null ? "" : ` — ${said}`}`;
}

/** What the app is made of, in words. */
function sourceWords(entry: SitePullEntry): string {
  switch (entry.source) {
    case "project-app":
      return `the app from the kept project's ${entry.from}/`;
    case "app":
      return "the kept app, as it is";
    case "files":
      return "the kept files, as built files (site.mjs + site/)";
    case "built":
      return "the files it serves, as built files (site.mjs + site/)";
    default:
      return "nothing";
  }
}

/** The plan, one site a line, on stderr. */
function printPlan(report: SitePullReport, named: string): void {
  step(`Sites on ${named}`);
  if (report.sites.length === 0) detail("None: the workspace has no sites.");
  for (const entry of report.sites) {
    const where = entry.dir === null ? "" : ` → ${entry.dir}/`;
    info(`${entry.site} (${buildWords(entry)})${where}`);
    if (entry.status === "write") detail(`${sourceWords(entry)}, ${entry.files} file${entry.files === 1 ? "" : "s"}`);
    if (entry.note !== null) detail(entry.note);
  }
}

/** The warnings a pull's report carries, one per site that is not written as read. */
function warnEntries(report: SitePullReport): void {
  for (const entry of report.sites) {
    if (entry.status === "exists") {
      warn(`${entry.site}: ${entry.dir}/ is already there and was kept. \`xanosdk site pull ${entry.site} --force\` replaces it.`, "site.kept");
    }
    else if (entry.status === "blocked") warn(`${entry.site}: not pulled — ${entry.note ?? "it has nowhere to go"}.`, "site.blocked");
    else if (entry.status === "no-source" || entry.status === "no-build") {
      warn(`${entry.site}: nothing to pull — ${entry.note ?? "no source"}.`, "site.no-source");
    } else if (entry.status === "write" && entry.source === "built") {
      warn(`${entry.site}: ${entry.note ?? "no source was kept"}.`, "site.built-fallback");
    }
  }
}

/**
 * Pull the sites' live code into `projectDir`, listing the plan and confirming
 * first: `site pull`, and the step `pull --with-sites` / `init --with-sites`
 * run after the backend. `command` is what a needs-confirmation rerun names.
 * Under `--json` only `site pull` writes the report; the others keep their
 * own one document and say this step on stderr.
 */
export async function pullSitesStep(
  args: ParsedArgs,
  target: StaticHostReadTarget,
  projectDir: string,
  named: string,
  opts: { command: string; names?: readonly string[]; document: boolean },
): Promise<SitePullReport> {
  const { pullSites } = await import("./sites-api.js");
  const { confirm } = await import("./prompt.js");
  const { yesRerun } = await import("./retry-command.js");
  let shown = false;
  const report = await pullSites({
    target,
    projectDir,
    ...(opts.names === undefined || opts.names.length === 0 ? {} : { sites: opts.names }),
    // Only `site pull` replaces: `init --force` means a non-empty target directory.
    force: opts.command === "site pull" && args.force === true,
    confirm: async (plan) => {
      printPlan(plan, named);
      shown = true;
      if (args.yes === true) return true;
      const writing = plan.sites.filter((s) => s.status === "write");
      const replacing = writing.filter((s) => s.replaces).map((s) => `${s.dir}/`);
      return confirm(
        `Write ${writing.length === 1 ? `the site "${writing[0]!.site}"` : `${writing.length} sites`} into ` +
          `${writing.map((s) => `${s.dir}/`).join(", ")}` +
          `${replacing.length === 0 ? "" : `, replacing what ${replacing.join(", ")} ${replacing.length === 1 ? "holds" : "hold"} now`}?`,
        { flag: "--yes", refusal: { details: { written: false }, ...yesRerun(args, opts.command) } },
      );
    },
  });
  if (!shown) printPlan(report, named);
  warnEntries(report);
  if (report.declined) info("Nothing was written.");
  else if (report.applied) {
    for (const entry of report.sites) {
      if (entry.status === "write") success(`Pulled ${entry.site} into ${entry.dir}/`);
    }
    if (report.siteLine !== null) detail(`package.json now names the site "${report.siteLine}" (\`xanosdk.@xano/sdk.staticHost\`).`);
    if (report.scriptsAdded) detail("package.json gained `dev` and `build` scripts that serve and copy frontend/site/ (node frontend/site.mjs).");
    detail("`xanosdk frontend list` shows the apps and the site each publishes to.");
  } else if (!report.sites.some((s) => s.status === "write")) info("Nothing to write.");
  if (opts.document && isMachineOutput(args)) writeJson({ ...report, verb: "site pull" });
  return report;
}

async function runSitePull(args: ParsedArgs, opts: SiteCommandOptions): Promise<void> {
  const names = args.positionals;
  const bad = names.filter((n) => !isSiteName(n));
  if (bad.length > 0) {
    throw new UsageError(
      `${bad.map((n) => `"${n}"`).join(", ")} ${bad.length === 1 ? "is not a site name" : "are not site names"}: lowercase letters and digits only, like "default" or "shop".`,
      { hintFor: { command: "site", subcommand: "pull" } },
    );
  }
  const resolved = await siteBackend(args, "pull", opts);
  await pullSitesStep(args, readTarget(resolved), process.cwd(), describeBackend(resolved), {
    command: "site pull",
    names,
    document: true,
  });
}

/**
 * The step `pull --with-sites` and `init --from workspace` (by default, see
 * {@link runInitSites}) run after the backend: the workspace's sites into
 * `projectDir`.
 */
export async function runWithSites(args: ParsedArgs, projectDir: string, command: "pull" | "init", opts: SiteCommandOptions = {}): Promise<void> {
  const resolved = await resolveBackend(requireBackendSlot("site", "pull", "on"), "workspace", {
    credential: () => getAccessToken(args),
    profile: args.profile,
    ...(opts.deps === undefined ? {} : { deps: opts.deps }),
  });
  await pullSitesStep(args, readTarget(resolved), projectDir, describeBackend(resolved), { command, document: false });
}

/**
 * The sites step `init --from workspace` runs by default after the backend
 * (`--no-sites` skips it). Sites are a bonus to the backend just written, so
 * nothing here fails the init: off a terminal without `--yes` the question
 * cannot be asked, so the sites are skipped with a note, and a workspace whose
 * sites cannot be read is reported the same way.
 */
export async function runInitSites(args: ParsedArgs, projectDir: string, opts: SiteCommandOptions = {}): Promise<void> {
  const rel = relative(process.cwd(), projectDir).split(sep).join("/");
  const later = `run \`xanosdk site pull\`${rel === "" ? "" : ` in ${rel}/`} (or re-run with --yes)`;
  if (args.yes !== true && process.stdin.isTTY !== true) {
    info(`Sites not pulled: ${later}.`);
    return;
  }
  try {
    await runWithSites(args, projectDir, "init", opts);
  } catch (err) {
    // Ctrl-C at the question (exit 130) is the user's to end the run with.
    if ((err as { exitCode?: unknown } | null)?.exitCode === 130) throw err;
    info(`Sites not pulled (${err instanceof Error ? err.message : String(err)}): ${later}.`);
  }
}

/** The workspace's site names, or `undefined` when they cannot be read (the caller carries on without them). */
export async function workspaceSiteNames(args: ParsedArgs, opts: SiteCommandOptions = {}): Promise<string[] | undefined> {
  try {
    const resolved = await resolveBackend(requireBackendSlot("site", "pull", "on"), "workspace", {
      credential: () => getAccessToken(args),
      profile: args.profile,
      ...(opts.deps === undefined ? {} : { deps: opts.deps }),
    });
    const { listStaticHostNames } = await import("../deploy/static-host.js");
    return await listStaticHostNames(readTarget(resolved));
  } catch {
    return undefined;
  }
}

/**
 * After a backend `pull` from the workspace: say which sites the project names
 * are live on a build its frontend does not hold, and how to bring each down.
 * Changes nothing, and is skipped quietly when the sites cannot be read — a
 * hint is never worth failing a pull over.
 */
export async function hintSiteDrift(args: ParsedArgs, projectDir: string, opts: SiteCommandOptions = {}): Promise<void> {
  let drift: SiteDrift[];
  try {
    const resolved = await resolveBackend(requireBackendSlot("site", "pull", "on"), "workspace", {
      credential: () => getAccessToken(args),
      profile: args.profile,
      ...(opts.deps === undefined ? {} : { deps: opts.deps }),
    });
    const { siteDrift } = await import("./sites-api.js");
    drift = await siteDrift(readTarget(resolved), projectDir);
  } catch {
    return;
  }
  for (const d of drift) info(driftWords(d));
}

/** `shop is live on build 136 (published from commit 011765b), which isn't in this frontend. Run …`. */
export function driftWords(d: SiteDrift): string {
  const where = d.env === "prod" ? "live on Prod on" : "live on";
  const from = d.commit === null ? "" : ` (published from commit ${d.commit.sha}${d.commit.dirty ? " with uncommitted changes" : ""})`;
  const run = `xanosdk site pull ${d.site}${d.dir === null ? "" : " --force"}`;
  const replaces = d.dir === null ? "" : `, replacing ${d.dir}/`;
  return `${d.site} is ${where} build ${d.build.id}${from}, which isn't in this frontend. Run \`${run}\` to bring it down${replaces}.`;
}

/**
 * `pull --with-sites` asks before it writes. Off a terminal without `--yes`
 * that question cannot be asked, so the run is refused before the backend is
 * pulled rather than after. (`init` skips the sites with a note instead.)
 */
export async function refuseWithSitesOffTerminal(args: ParsedArgs, command: "pull" | "init"): Promise<void> {
  if (args.withSites !== true || args.yes === true) return;
  if (process.stdin.isTTY !== true) {
    const { needsConfirmation } = await import("./prompt.js");
    const { yesRerun } = await import("./retry-command.js");
    throw needsConfirmation("Write each site's live code into frontend/?", { details: { written: false }, ...yesRerun(args, command) });
  }
}

/* ------------------------------------------------------------------ *
 * site serve
 * ------------------------------------------------------------------ */

async function runSiteServe(args: ParsedArgs, opts: SiteCommandOptions): Promise<void> {
  const hint = { hintFor: { command: "site", subcommand: "serve" } };
  const [site, rawBuild] = args.positionals;
  if (site === undefined || rawBuild === undefined) {
    throw new UsageError("`xanosdk site serve` needs the site and the build, e.g. `xanosdk site serve shop 136 --env prod`.", {
      helpFor: { command: "site", subcommand: "serve" },
    });
  }
  if (!isSiteName(site)) throw new UsageError(`"${site}" is not a site name: lowercase letters and digits only, like "default" or "shop".`, hint);
  if (!/^[1-9]\d*$/.test(rawBuild)) {
    throw new UsageError(`"${rawBuild}" is not a build id: the build's number, as \`xanosdk site list\` names it.`, hint);
  }
  const env = args.siteEnv;
  if (env === undefined) {
    throw new UsageError("`xanosdk site serve` needs `--env dev` or `--env prod`: the environment that serves the build.", hint);
  }
  const buildId = Number(rawBuild);
  const resolved = await siteBackend(args, "serve", opts);
  const target = readTarget(resolved);
  const named = describeBackend(resolved);
  const { serveBuild } = await import("./sites-api.js");
  if (env === "prod" && args.yes !== true) {
    const { confirm } = await import("./prompt.js");
    const { yesRerun } = await import("./retry-command.js");
    const ok = await confirm(`Serve build ${buildId} of the site "${site}" on Prod, on ${named}? Visitors get it at once.`, {
      flag: "--yes",
      refusal: { details: { served: false }, ...yesRerun(args, "site serve") },
    });
    if (!ok) {
      info("Nothing was changed.");
      if (isMachineOutput(args)) writeJson({ site, env, buildId, served: false, declined: true });
      return;
    }
  }
  const result = await serveBuild({ target, site, buildId, env });
  if (isMachineOutput(args)) {
    writeJson({ ...result, served: true });
    return;
  }
  const label = env === "prod" ? "Prod" : "Dev";
  success(`${label} of "${site}" now serves build ${buildId}${result.previous === null ? "" : ` (it served ${result.previous.id === null ? result.previous.canonical : `build ${result.previous.id}`})`}`);
  if (result.url !== null) detail(result.url);
}
