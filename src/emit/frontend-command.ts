/**
 * `xanosdk frontend list` and `xanosdk frontend split` (DEV-10042).
 *
 * `list` prints {@link frontendApps}: whether `frontend/` is one app (flat),
 * one app per site (nested), or none, and the site each app publishes to.
 * `--json` is the document Xano Studio and scripts read.
 *
 * `split` turns a flat frontend into a nested one, so more sites can sit
 * beside it: everything in `frontend/` moves into `frontend/<site>/`, the
 * project's package.json scripts that name `frontend/` are pointed at the new
 * folder, and the `staticHost` line is dropped (the folder names the site
 * now). Then the moved app is built exactly as `publish` would build it. If
 * anything fails — the move, the rewrite, finding the app, its build, or a
 * build with nothing to serve — everything is put back as it was and the run
 * exits non-zero saying what broke. Never run implicitly.
 *
 * Node-only (fs, and a build process); lazily imported by the dispatcher.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { unknownSubcommand, UsageError } from "./errors.js";
import { isMachineOutput, writeJson } from "./output.js";
import { detail, info, step, success, warn } from "./ui.js";
import {
  DEFAULT_SITE,
  FRONTEND_DIR,
  frontendApps,
  isSiteName,
  readStaticHostLine,
  STATIC_HOST_FIELD,
  type FrontendApps,
} from "./frontend-apps.js";
import { composeManifest, SDK_PACKAGE } from "./project-config.js";
import { buildFrontendApp, FrontendBuildError, type BuildRunner } from "./static-sites.js";

/** Seams the tests replace; production callers pass nothing. */
export interface FrontendCommandOptions {
  /** Runs an app's build script (default: the package manager's `run build`). */
  run?: BuildRunner;
}

export async function runFrontendCommand(args: ParsedArgs, opts: FrontendCommandOptions = {}): Promise<void> {
  if (args.subcommand === "list") return runFrontendList(args);
  if (args.subcommand === "split") return runFrontendSplit(args, opts);
  throw unknownSubcommand("frontend", args.subcommand);
}

function runFrontendList(args: ParsedArgs): void {
  const found: FrontendApps = frontendApps(process.cwd());
  if (isMachineOutput(args)) {
    writeJson(found);
    return;
  }
  if (found.layout === "none") {
    step(`No frontend app in ${FRONTEND_DIR}/`);
    detail(`Publish a built directory with \`xanosdk publish <dir>\`, or add ${FRONTEND_DIR}/ (one app) or ${FRONTEND_DIR}/<site>/ (one per site).`);
    return;
  }
  if (found.layout === "flat") {
    step(`${FRONTEND_DIR}/ is one app, publishing to the site "${found.apps[0]!.site}"`);
    detail(`\`xanosdk frontend split\` moves it into ${FRONTEND_DIR}/${found.apps[0]!.site}/ so more sites can sit beside it.`);
    return;
  }
  step(`${FRONTEND_DIR}/ holds one app per site`);
  for (const app of found.apps) {
    const how = app.build === "script" ? "built by its build script" : app.build === "built-files" ? "its site/ files, as they are" : "its files, as they are";
    info(`${app.site}  ${app.dir}  (${how})`);
  }
  if (found.shared !== undefined && found.shared.length > 0) detail(`Shared code, never published: ${found.shared.join(", ")}`);
}

/**
 * A package.json script with every path into `frontend/` pointed into
 * `frontend/<site>/`: `./frontend/dist` → `./frontend/shop/dist`,
 * `node frontend/site.mjs build` → `node frontend/shop/site.mjs build`,
 * `cd frontend` → `cd frontend/shop`. A word that merely contains
 * "frontend" (`xano:deploy:frontend`, `my-frontend`) is left alone.
 */
export function rewriteFrontendPaths(script: string, site: string): string {
  return script.replace(
    /(^|[\s"'=(,;&|])(\.\/)?frontend(?=$|[/\s"');&|,])/g,
    (_m, lead: string, dot: string | undefined) => `${lead}${dot ?? ""}${FRONTEND_DIR}/${site}`,
  );
}

/** What `frontend split` did, as `--json` reports it. */
export interface FrontendSplitReport {
  site: string;
  from: string;
  to: string;
  /** The entries moved from `frontend/` into `frontend/<site>/`. */
  moved: string[];
  /** The package.json scripts whose paths were pointed into the new folder. */
  scripts: string[];
  /** Whether the `staticHost` line was removed. */
  lineRemoved: boolean;
  /** The moved app's build: where the files its site serves are. */
  build: { output: string };
}

async function runFrontendSplit(args: ParsedArgs, opts: FrontendCommandOptions): Promise<void> {
  const hint = { hintFor: { command: "frontend", subcommand: "split" } };
  const cwd = process.cwd();
  const layout = frontendApps(cwd);
  if (layout.layout === "nested") {
    throw new UsageError(
      `${FRONTEND_DIR}/ already holds one app per site (${layout.apps.map((a) => a.dir).join(", ")}). Nothing was moved.`,
      hint,
    );
  }
  if (layout.layout === "none") {
    throw new UsageError(`${FRONTEND_DIR}/ holds no app to move. Nothing was moved.`, hint);
  }
  const line = readStaticHostLine(cwd, { warn: (m) => warn(m, "static.site-line-ignored") });
  const site = args.site ?? line ?? DEFAULT_SITE;
  if (!isSiteName(site)) {
    throw new UsageError(`\`--site ${site}\` is not a site name: lowercase letters and digits only, like "shop".`, hint);
  }
  const root = join(cwd, FRONTEND_DIR);
  const target = join(root, site);
  const entries = readdirSync(root).sort();
  if (entries.includes(site)) {
    throw new UsageError(
      `${FRONTEND_DIR}/${site} already exists inside the app, so the app cannot move into a folder of that name. ` +
        `Pick another with \`--site <name>\`. Nothing was moved.`,
      hint,
    );
  }

  const pkgPath = join(cwd, "package.json");
  const pkgRaw = existsSync(pkgPath) ? readFileSync(pkgPath, "utf8") : undefined;
  // Parsed before anything moves: a manifest that cannot be rewritten stops the split here.
  let pkgNext: string | undefined;
  const changedScripts: string[] = [];
  let lineRemoved = false;
  if (pkgRaw !== undefined) {
    try {
      pkgNext = composeManifest(pkgRaw, (manifest) => {
        const scripts = manifest.scripts;
        if (scripts !== null && typeof scripts === "object" && !Array.isArray(scripts)) {
          for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
            if (typeof value !== "string") continue;
            const next = rewriteFrontendPaths(value, site);
            if (next !== value) {
              (scripts as Record<string, unknown>)[name] = next;
              changedScripts.push(name);
            }
          }
        }
        const block = manifest.xanosdk;
        if (block !== null && typeof block === "object" && !Array.isArray(block)) {
          const own = (block as Record<string, unknown>)[SDK_PACKAGE];
          if (own !== null && typeof own === "object" && !Array.isArray(own) && STATIC_HOST_FIELD in own) {
            delete (own as Record<string, unknown>)[STATIC_HOST_FIELD];
            lineRemoved = true;
            if (Object.keys(own).length === 0) delete (block as Record<string, unknown>)[SDK_PACKAGE];
            if (Object.keys(block).length === 0) delete manifest.xanosdk;
          }
        }
      });
    } catch {
      throw new UsageError(`${pkgPath} could not be parsed as JSON, so its scripts cannot be updated. Nothing was moved.`, hint);
    }
  }

  step(`Moving ${FRONTEND_DIR}/ into ${FRONTEND_DIR}/${site}/`);
  const moved: string[] = [];
  let pkgWritten = false;
  const undo = (): string[] => {
    const problems: string[] = [];
    const attempt = (what: string, fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        problems.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    // What the verification build wrote into the new folder goes; what was moved goes back.
    if (existsSync(target)) {
      for (const name of readdirSync(target)) {
        if (!moved.includes(name)) attempt(`removing ${FRONTEND_DIR}/${site}/${name}`, () => rmSync(join(target, name), { recursive: true, force: true }));
      }
    }
    for (const name of [...moved].reverse()) {
      attempt(`moving ${name} back`, () => renameSync(join(target, name), join(root, name)));
    }
    attempt(`removing ${FRONTEND_DIR}/${site}`, () => {
      if (existsSync(target)) rmdirSync(target);
    });
    if (pkgWritten && pkgRaw !== undefined) attempt("restoring package.json", () => writeFileSync(pkgPath, pkgRaw));
    return problems;
  };

  let output: string;
  try {
    mkdirSync(target);
    for (const name of entries) {
      renameSync(join(root, name), join(target, name));
      moved.push(name);
    }
    if (pkgRaw !== undefined && pkgNext !== undefined && pkgNext !== pkgRaw) {
      pkgWritten = true;
      writeFileSync(pkgPath, pkgNext);
    }
    const after = frontendApps(cwd);
    const app = after.layout === "nested" ? after.apps.find((a) => a.site === site) : undefined;
    if (app === undefined) {
      throw new FrontendBuildError(
        `after the move, ${FRONTEND_DIR}/${site} is not an app a site can publish: it needs its own package.json with a ` +
          `\`build\` script, or an index.html. (A frontend the project's root package.json builds needs a package.json ` +
          `of its own before it can be split.)`,
        site,
      );
    }
    const built = await buildFrontendApp(cwd, app, { strict: true, ...(opts.run === undefined ? {} : { run: opts.run }) });
    const { assertStaticDir, StaticDirError } = await import("../deploy/static-host.js");
    try {
      assertStaticDir(join(cwd, ...built.output.split("/")));
    } catch (err) {
      if (err instanceof StaticDirError) throw new FrontendBuildError(err.message, site);
      throw err;
    }
    output = built.output;
  } catch (err) {
    const problems = undo();
    const why = err instanceof Error ? err.message : String(err);
    throw Object.assign(
      new Error(
        `The split was undone: ${why}` +
          (problems.length === 0
            ? `\n${FRONTEND_DIR}/ and package.json are as they were.`
            : `\nPutting everything back did not fully work — check ${FRONTEND_DIR}/ and package.json:\n${problems.join("\n")}`),
      ),
      { exitCode: 1 },
    );
  }

  const report: FrontendSplitReport = {
    site,
    from: FRONTEND_DIR,
    to: `${FRONTEND_DIR}/${site}`,
    moved,
    scripts: changedScripts,
    lineRemoved,
    build: { output },
  };
  if (isMachineOutput(args)) {
    writeJson(report);
    return;
  }
  success(`${FRONTEND_DIR}/ is now ${FRONTEND_DIR}/${site}/, publishing to the site "${site}"`);
  if (changedScripts.length > 0) detail(`package.json scripts updated: ${changedScripts.join(", ")}`);
  if (lineRemoved) detail(`Dropped "${STATIC_HOST_FIELD}" from package.json: the folder names the site now.`);
  detail(`Built ${output}. Add ${FRONTEND_DIR}/<site>/ for another site; \`xanosdk publish\` publishes every one.`);
  detail(`Other files that name ${FRONTEND_DIR}/ (a vite.config, tsconfig.json, .gitignore) were not changed.`);
}
