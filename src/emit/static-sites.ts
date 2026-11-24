/**
 * Which site each static publish goes to, decided once before anything is
 * signed into or sent (DEV-10042).
 *
 * `deploy --static <dir>` and `publish <dir>` publish ONE build. Its site is,
 * in order: a typed `--static-host`; for a build inside a nested app's folder
 * (`frontend/shop/dist`), that folder's site; the project's `staticHost` line;
 * else `default` — the host the build route creates by itself, and exactly
 * today's request when the project names nothing.
 *
 * A NESTED project (`frontend/<site>/`, see `frontend-apps.ts`) publishes
 * every app to its own site when the publish names the frontend as a whole:
 * `publish` with no directory, `publish frontend`, or `deploy --static
 * frontend`. Each app is built here first (its own `build` script, run in its
 * folder), so a build that fails costs no backend import and no upload.
 * `--site <name>` limits the publish to one app.
 *
 * A site the project names (its line, or a nested app's folder) is created on
 * the target when the target does not have it yet — a fresh ephemeral, or a
 * replace that cleared every site, has only `default`. A typed
 * `--static-host` keeps today's refusal of a name the target does not hold.
 *
 * Node-only; lazily imported by the commands that publish.
 */
import { readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { UsageError } from "./errors.js";
import {
  DEFAULT_SITE,
  FRONTEND_DIR,
  frontendApps,
  isSiteName,
  readStaticHostLine,
  type FrontendApp,
  type FrontendApps,
} from "./frontend-apps.js";
import { detail, info, step, warn } from "./ui.js";
import type { AppSourcePack } from "../deploy/app-source.js";

/** One app of a nested project, built and ready to publish to its site. */
export interface StaticAppBuild {
  /** The site it publishes to (its folder's name). */
  site: string;
  /** Its folder, relative to the project root, POSIX-separated (`frontend/shop`). */
  dir: string;
  /** The directory whose files the site serves: the build output, or the folder itself for an app with no build. */
  output: string;
  /**
   * Set by `prepareStaticPlan` unless `--static-source` or `--no-static-source`
   * was typed, or the folder could not be packed: the app's folder, archived,
   * sent beside the build and kept as the build's source (DEV-10124).
   */
  source?: AppSourcePack;
}

/** The folders a build is looked for in, in order, inside an app's folder. */
export const BUILD_OUTPUT_CANDIDATES = ["dist", "build", "out"] as const;

/** A frontend app that could not be built, or built nothing to publish. Exit 1, before anything was sent. */
export class FrontendBuildError extends Error {
  override readonly name = "FrontendBuildError";
  constructor(
    message: string,
    /** The site whose app failed. */
    readonly site: string,
    /** What the build printed, when it ran. */
    readonly output?: string,
  ) {
    super(message);
  }
}

/** Runs an app's `build` script; the seam tests replace. Resolves the exit status and everything it printed. */
export type BuildRunner = (appDir: string) => Promise<{ status: number; output: string; command: string }>;

/** The default {@link BuildRunner}: `<package manager> run build` in the app's folder, its output captured. */
export const runAppBuild: BuildRunner = async (appDir) => {
  const { detectPackageManager } = await import("./package-manager.js");
  const { runNpmQuiet } = await import("./npm.js");
  const manager = detectPackageManager(appDir);
  const res = await runNpmQuiet(["run", "build"], appDir, { manager });
  return { status: res.status, output: res.output, command: `${manager} run build` };
};

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

/**
 * The build an app's folder holds after its build ran: the first of
 * {@link BUILD_OUTPUT_CANDIDATES} with an `index.html` (or a server half,
 * `.xano-ssr/`), else the first that exists at all (the publish then says what
 * it lacks), else `undefined`. Relative to the app's folder.
 */
export function findBuildOutput(appDir: string): string | undefined {
  const present = BUILD_OUTPUT_CANDIDATES.filter((name) => isDir(join(appDir, name)));
  return (
    present.find((name) => isFile(join(appDir, name, "index.html")) || isDir(join(appDir, name, ".xano-ssr"))) ?? present[0]
  );
}

/** A module script a browser cannot execute: TypeScript or JSX source, by extension. */
const SOURCE_SCRIPT = /\.(?:tsx?|jsx|mts|cts)$/i;

/** The TypeScript/JSX source `dir/index.html` loads, if it loads any — the sign of an app's source, not its build. */
export function unbuiltSourceScript(dir: string): string | undefined {
  let html: string;
  try {
    html = readFileSync(join(dir, "index.html"), "utf8");
  } catch {
    return undefined;
  }
  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag[0]);
    const path = (src?.[1] ?? src?.[2] ?? src?.[3] ?? "").split(/[?#]/)[0]!;
    if (SOURCE_SCRIPT.test(path)) return path;
  }
  return undefined;
}

/** The last lines of what a build printed: enough to see why it failed, not the whole install log. */
function tail(output: string, lines = 25): string {
  const all = output.replace(/\s+$/, "").split(/\r?\n/);
  return (all.length > lines ? ["…", ...all.slice(-lines)] : all).join("\n");
}

/**
 * Build one nested app and return what its site serves.
 *
 * - `script`: its own `build` script runs in its folder; the output is found
 *   by {@link findBuildOutput}.
 * - `built-files`: Xano Studio's layout for a site with no build; `site/` is served as it is.
 * - `none`: an `index.html` and no build script; the folder is served as it is.
 *
 * Throws {@link FrontendBuildError} when the build fails or writes nothing to publish.
 */
export async function buildFrontendApp(
  projectDir: string,
  app: FrontendApp,
  opts: { run?: BuildRunner; quiet?: boolean; strict?: boolean } = {},
): Promise<StaticAppBuild> {
  const abs = join(projectDir, ...app.dir.split("/"));
  if (app.build === "built-files") return { site: app.site, dir: app.dir, output: `${app.dir}/site` };
  if (app.build !== "script") {
    const script = unbuiltSourceScript(abs);
    if (script !== undefined) {
      const message =
        `${app.dir}/index.html loads ${script}, TypeScript/JSX source a browser cannot run, and ${app.dir} has no ` +
        `\`build\` script of its own. Give it a package.json whose \`build\` script writes ${app.dir}/dist.`;
      if (opts.strict === true) throw new FrontendBuildError(message, app.site);
      warn(message, "publish.unbuilt-source");
    }
    return { site: app.site, dir: app.dir, output: app.dir };
  }
  const run = opts.run ?? runAppBuild;
  if (opts.quiet !== true) step(`Building ${app.dir} for the site "${app.site}"`);
  const res = await run(abs);
  if (res.status !== 0) {
    throw new FrontendBuildError(
      `${app.dir}: \`${res.command}\` failed (exit ${res.status}), so nothing was published.` +
        (res.output.trim() === "" ? "" : `\n${tail(res.output)}`),
      app.site,
      res.output,
    );
  }
  const out = findBuildOutput(abs);
  if (out === undefined) {
    throw new FrontendBuildError(
      `${app.dir}: \`${res.command}\` succeeded but wrote none of ${BUILD_OUTPUT_CANDIDATES.map((d) => `${d}/`).join(", ")} ` +
        `in ${app.dir}, so there is nothing to publish. Point its build at ${app.dir}/dist.`,
      app.site,
      res.output,
    );
  }
  if (opts.quiet !== true) detail(`Built ${app.dir}/${out}`);
  return { site: app.site, dir: app.dir, output: `${app.dir}/${out}` };
}

/** Whether `dir` (as typed, from `cwd`) is the project's `frontend/` itself. */
export function isFrontendRoot(cwd: string, dir: string): boolean {
  return resolve(cwd, dir) === resolve(cwd, FRONTEND_DIR);
}

/** The nested app whose folder holds `dir`, when one does. */
function appHolding(cwd: string, dir: string, layout: FrontendApps): FrontendApp | undefined {
  if (layout.layout !== "nested") return undefined;
  const target = resolve(cwd, dir);
  return layout.apps.find((app) => {
    const root = resolve(cwd, ...app.dir.split("/"));
    return target === root || target.startsWith(root + sep);
  });
}

/** How a list of paths reads in one line: the first few, then how many more. */
function someOf(paths: readonly string[], shown = 8): string {
  return paths.length <= shown ? paths.join(", ") : `${paths.slice(0, shown).join(", ")}, and ${paths.length - shown} more`;
}

/**
 * Pack an app folder's source for its build (`app-source.ts`) and say what is
 * sent before anything is: the file count, and each file left out for a name
 * that usually holds a secret. A folder that cannot be packed is said as
 * `static.source-skipped` and its build goes alone: `undefined`.
 */
async function packSource(cwd: string, appDir: string, output: string): Promise<AppSourcePack | undefined> {
  const { packAppSource } = await import("../deploy/app-source.js");
  const packed = packAppSource(cwd, appDir, { exclude: [output] });
  const leftOut = packed.leftOut ?? [];
  if ("skipped" in packed) {
    warn(
      `The source of ${appDir} is not sent with its build: ${packed.skipped}. The build is published without it, ` +
        `so a \`site pull\` brings its built files rather than its code.`,
      "static.source-skipped",
      ["Pass `--static-source <archive>` to send an archive of your own, or `--no-static-source` to send none."],
    );
    return undefined;
  }
  detail(`Sends the source of ${appDir} with its build: ${packed.files} ${packed.files === 1 ? "file" : "files"} git would commit.`);
  if (leftOut.length > 0) {
    detail(`Left out of ${appDir}'s source, as names that usually hold secrets: ${someOf(leftOut)}.`);
  }
  return { dir: appDir, data: packed.data, files: packed.files, leftOut };
}

/** A one-app frontend (`frontend/` itself) when `dir` is it or lies inside it. */
function flatAppHolding(cwd: string, dir: string, layout: FrontendApps): string | undefined {
  if (layout.layout !== "flat") return undefined;
  const root = resolve(cwd, FRONTEND_DIR);
  const target = resolve(cwd, dir);
  return target === root || target.startsWith(root + sep) ? FRONTEND_DIR : undefined;
}

/** What a command calls the flag that took the directory, for messages. */
type StaticCommand = "deploy" | "publish";

/**
 * Decide where this run's static publish goes, and build a nested project's
 * apps. Returns `args` with {@link ParsedArgs.staticLineHost} or
 * {@link ParsedArgs.staticApps} filled in, and the app folder whose source
 * goes with the build ({@link ParsedArgs.staticAppSource}, or each app's
 * `source`), packed now unless `--static-source` or `--no-static-source` was typed;
 * returns it unchanged when none of that applies.
 *
 * `dir` is the build the run was given (`--static`, `publish <dir>`), or
 * `undefined` for a bare `publish`, which publishes a nested project's apps.
 * Run from the project root, before sign-in and before any write.
 */
export async function prepareStaticPlan(
  args: ParsedArgs,
  command: StaticCommand,
  dir: string | undefined,
  opts: { run?: BuildRunner } = {},
): Promise<ParsedArgs> {
  const cwd = process.cwd();
  const hint = { hintFor: { command } };
  if (args.site !== undefined && !isSiteName(args.site)) {
    throw new UsageError(`\`--site ${args.site}\` is not a site name: lowercase letters and digits only, like "shop".`, hint);
  }
  if (args.staticSource !== undefined && args.noStaticSource === true) {
    throw new UsageError(
      `\`--static-source\` sends this archive as the app's source and \`--no-static-source\` sends none: drop one of them.`,
      hint,
    );
  }
  // Each app's own folder goes with its build unless the run sends its own archive or none.
  const defaultSource = args.staticSource === undefined && args.noStaticSource !== true;
  const layout = frontendApps(cwd);
  const wholeFrontend = dir === undefined || isFrontendRoot(cwd, dir);

  if (wholeFrontend && layout.layout === "nested") {
    if (args.staticHost !== undefined) {
      throw new UsageError(
        `\`--static-host\` names one site, and this project's frontend holds one app per site ` +
          `(${layout.apps.map((a) => a.dir).join(", ")}), each publishing to the site its folder is named for. ` +
          `Drop \`--static-host\`; \`--site <name>\` publishes one of them.`,
        hint,
      );
    }
    let apps = layout.apps;
    if (args.site !== undefined) {
      const one = apps.find((a) => a.site === args.site);
      if (one === undefined) {
        throw new UsageError(
          `\`--site ${args.site}\` names no app in this project: its sites are ${apps.map((a) => `"${a.site}"`).join(", ")} ` +
            `(one per folder under ${FRONTEND_DIR}/).`,
          hint,
        );
      }
      apps = [one];
    }
    if (args.staticSource !== undefined && apps.length > 1) {
      throw new UsageError(
        `\`--static-source\` sends one app's source archive, and this publishes ${apps.length} sites ` +
          `(${apps.map((a) => a.site).join(", ")}). Drop it: each app's own folder is sent with its build by default. ` +
          `Or add \`--site <name>\` to publish the one it belongs to.`,
        hint,
      );
    }
    const built: StaticAppBuild[] = [];
    for (const app of apps) {
      try {
        built.push(await buildFrontendApp(cwd, app, opts.run === undefined ? {} : { run: opts.run }));
      } catch (err) {
        if (err instanceof FrontendBuildError) {
          const done = built.length === 0 ? "" : ` (${built.map((b) => b.site).join(", ")} built; none published)`;
          throw new UsageError(`${err.message}${done}`, hint);
        }
        throw err;
      }
    }
    if (!defaultSource) return { ...args, staticApps: built };
    const withSources: StaticAppBuild[] = [];
    for (const b of built) {
      const source = await packSource(cwd, b.dir, b.output);
      withSources.push(source === undefined ? b : { ...b, source });
    }
    return { ...args, staticApps: withSources };
  }

  if (args.site !== undefined) {
    throw new UsageError(
      layout.layout === "nested"
        ? `\`--site\` picks one app of the whole frontend, and ${dir} is one build. Drop \`--site\`, or publish ` +
            `\`${FRONTEND_DIR}\` with \`--site ${args.site}\`.`
        : `\`--site\` picks one of a nested frontend's apps (\`${FRONTEND_DIR}/<site>/\`), and this project's frontend ` +
            `is one app. Drop it; \`--static-host <name>\` publishes to another site.`,
      hint,
    );
  }

  // One build. A site the project names: the folder it sits in, else the line.
  const folder = dir === undefined ? undefined : appHolding(cwd, dir, layout);
  // The app folder the build came from, whose source goes with it by default.
  const appDir = !defaultSource || dir === undefined ? undefined : (folder?.dir ?? flatAppHolding(cwd, dir, layout));
  const source = appDir === undefined || dir === undefined ? undefined : await packSource(cwd, appDir, dir);
  const withSource = (out: ParsedArgs): ParsedArgs => (source === undefined ? out : { ...out, staticAppSource: source });
  const named = folder?.site ?? readStaticHostLine(cwd, { warn: (m) => warn(m, "static.site-line-ignored") });
  if (named === undefined) return withSource(args);
  if (args.staticHost !== undefined) {
    if (args.staticHost !== named) {
      info(
        folder === undefined
          ? `Publishing to ${args.staticHost}; this project names ${named} in package.json.`
          : `Publishing to ${args.staticHost}; ${folder.dir} is the folder for ${named}.`,
      );
    }
    return withSource(args);
  }
  return withSource({ ...args, staticLineHost: named });
}

/**
 * The host a single-build upload goes to, and whether the project named it
 * (so it is created when missing), plus a nested project's apps — what each
 * `deployStaticTo` call passes. With nothing named, `{ host: args.staticHost }`:
 * today's call exactly.
 */
export function staticUpload(args: Pick<ParsedArgs, "staticHost" | "staticLineHost" | "staticApps"> & Partial<Pick<ParsedArgs, "staticAppSource">>): {
  host: string | undefined;
  opts: { createHost?: true; apps?: readonly StaticAppBuild[]; appSource?: AppSourcePack };
} {
  const host = args.staticHost ?? args.staticLineHost;
  return {
    host,
    opts: {
      ...(args.staticHost === undefined && args.staticLineHost !== undefined ? { createHost: true as const } : {}),
      ...(args.staticApps !== undefined && args.staticApps.length > 0 ? { apps: args.staticApps } : {}),
      ...(args.staticAppSource !== undefined ? { appSource: args.staticAppSource } : {}),
    },
  };
}

/** The directories a run publishes: each nested app's build, else the one `--static` build. */
export function staticDirsOf(args: Pick<ParsedArgs, "static" | "staticApps">): string[] {
  if (args.staticApps !== undefined && args.staticApps.length > 0) return args.staticApps.map((a) => a.output);
  return args.static === undefined ? [] : [args.static];
}

/** The site a single-build publish lands on, for a prompt or a message: the typed host, the project's, else `default`. */
export function publishedSite(args: Pick<ParsedArgs, "staticHost" | "staticLineHost">): string {
  return args.staticHost ?? args.staticLineHost ?? DEFAULT_SITE;
}

/**
 * What source this run sends beside its build(s), in one line for the publish
 * summary above its confirmation: each app folder and its file count, and how
 * many files were left out as secrets. `undefined` when it sends none of its own packing.
 */
export function sourceSummary(args: Pick<ParsedArgs, "staticApps"> & Partial<Pick<ParsedArgs, "staticAppSource">>): string | undefined {
  const packs = [
    ...(args.staticApps ?? []).flatMap((a) => (a.source === undefined ? [] : [a.source])),
    ...(args.staticAppSource === undefined ? [] : [args.staticAppSource]),
  ];
  if (packs.length === 0) return undefined;
  const each = packs.map((p) => `${p.dir} (${p.files} ${p.files === 1 ? "file" : "files"})`).join(", ");
  const out = packs.reduce((n, p) => n + p.leftOut.length, 0);
  return (
    `Source kept with the ${packs.length === 1 ? "build" : "builds"}: ${each}` +
    (out === 0 ? "." : `; ${out} ${out === 1 ? "file" : "files"} named like secrets left out.`)
  );
}
