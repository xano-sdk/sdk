/**
 * The scaffold engine shared by `xanosdk init` and `xanosdk init --from <source>`.
 *
 * Both commands answer the same question — "give me a Xano SDK project" — and
 * differ only in what fills `xano/`: an empty starter, or a workspace decoded
 * from a Xano bundle. Everything else (the overwrite decision, writing the tree,
 * the agent brief, the optional `npm install`) is one code path
 * here, so a script added to the scaffold's `package.json` cannot land in one
 * command and not the other.
 *
 * The one asymmetry is `regenerable`. A pulled project's `xano/` is
 * machine-written and disposable, which earns it a behaviour `init` must not
 * have: a re-run refreshes that directory without demanding `--force`.
 *
 * EVERY regenerable write clears `xano/` first — the no-`--force` refresh and
 * the `--force` full scaffold alike — keeping only what `PRESERVED_ON_REFRESH`
 * names. That is not an
 * optimisation but the correctness property that lets file layout change at all:
 * an in-place overwrite would leave a previous tree's files behind, still inside
 * the root tsconfig's `include`, importing symbols the new barrel no longer
 * exports, and `npm run build` would fail on orphans nobody edited.
 *
 * Node-only (node:fs + child_process); imported lazily by
 * the command modules so the browser-safe authoring bundle never pulls it in.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { condenseNpmError, runNpmQuiet, sameNpmFailure } from "./npm.js";
import { detectInstallRoot } from "./package-manager.js";
import { MCP_CONFIGS, MCP_SERVER_NAME, mcpServerCommand, projectFileCli, projectSdkDir } from "./invocation.js";
import { classifyNpmFailure } from "./init-modules.js";
import { removeEmptiedDirs, removeFiles } from "./backend-tree.js";
import { detail, info, success, warn, withSpinner } from "./ui.js";
import { UsageError } from "./errors.js";
import { isSorted, sortedKeys } from "./init-templates.js";
import {
  AGENTS_MD_PATH,
  renderAgentsMd,
  upsertManagedBlock,
  type GuidanceMode,
} from "./init-ai-presets.js";
import type { FrontendPreset } from "./frontend-presets.js";
import type { ThemeChoice } from "./theme-presets.js";

/** The backend directory every scaffolded project keeps its xanosdk source in. */
export const XANO_DIR = "xano";

/**
 * Provenance for a machine-written tree, and the signal that `xano/` may be
 * refreshed without `--force`. Lives inside `xano/` so the delete-and-rewrite
 * branch is self-cleaning — there is no marker left behind pointing at a
 * directory that no longer matches it.
 */
export const CODEGEN_MARKER = `${XANO_DIR}/.xanosdk-codegen.json`;

/**
 * Files under `xano/` that survive a refresh.
 *
 * `xano.lock` is not a hand edit — every build that compiles an entry file
 * places it beside that file, which for a scaffolded project is `xano/index.ts`, i.e.
 * inside the directory a refresh removes. It pins object identities across
 * deploys, so losing it silently re-derives guids for objects that already
 * exist.
 *
 * `.env` is here for a stronger reason than the lock has: a lost lock
 * re-derives identities, which is bad; a lost `.env` destroys the VALUES of the
 * backend's env vars, which this SDK deliberately never writes down anywhere
 * else, and which are therefore unrecoverable. `.env.example` is deliberately
 * ABSENT — it is generated from the declared names and the refresh rewrites it.
 * That split is the point: the example is machine-owned, the real file is the
 * user's.
 *
 * `.secrets.json` is here for the lock's reason rather than `.env`'s, and the
 * difference is worth keeping straight. It is machine-owned — a pull rewrites it
 * wholesale — so a refresh that dropped it loses nothing a later pull cannot
 * rebuild. But a refresh is not a pull: `xanosdk init --force` over an existing
 * project would leave the tree declaring gates whose tokens are gone until
 * someone pulls again, and the failure shows up as a deploy refusal rather than
 * as a missing file.
 *
 * Everything else under `xano/` really is disposable.
 *
 * Exported because `pull-command.ts` clears `xano/` by its own walk rather than
 * through `scaffoldProject`, and two lists is how a file ends up preserved on
 * one refresh path and deleted by the other.
 */
export const PRESERVED_ON_REFRESH: readonly string[] = ["xano.lock", ".env", ".secrets.json"];

/**
 * Files under `xano/` the project shell writes rather than a decode: neither
 * removed by a refresh nor reported as the author's own. The last two are a
 * project with no frontend's: the config `xano/` type-checks under, and, in an
 * existing project, the line-ending rule kept out of that project's own root.
 */
export const SHELL_FILES_IN_BACKEND: readonly string[] = ["lambdas/tsconfig.json", "tsconfig.json", ".gitattributes"];

/** One file to write, at a path relative to the project root. */
export interface ScaffoldFile {
  /** Relative POSIX path, e.g. `xano/index.ts`. */
  readonly path: string;
  readonly content: string;
}

/** What a scaffold run is allowed to do to the target directory. */
export type OverwriteMode =
  /** Write the whole project. */
  | "full"
  /** Rewrite `xano/` only, leaving the project shell in place. */
  | "refresh-xano"
  /** Refuse — the directory holds something this command did not write. */
  | "refuse";

/**
 * Whether dependencies were installed, and why not when they were not:
 * `skipped` is `--no-install`; `already-installed` is a refresh of a project
 * whose `node_modules` is already there, which has nothing to install.
 */
export type InstallOutcome = "installed" | "failed" | "skipped" | "already-installed";

export interface ScaffoldOptions {
  /** Absolute path to the project root. */
  readonly targetDir: string;
  readonly files: readonly ScaffoldFile[];
  /** Write `AGENTS.md` — false under `--no-agents-md`. */
  readonly agentsMd: boolean;
  readonly appName: string;
  readonly force: boolean;
  readonly noInstall: boolean;
  /**
   * True for `init --from`: `xano/` is machine-written, so it may be refreshed in
   * place and is cleared before a full (re)scaffold. It also selects the
   * `AGENTS.md` guidance that tells an agent so.
   */
  readonly regenerable: boolean;
  /**
   * The installed `@xano/sdk` version, stamped into `AGENTS.md`'s managed
   * block. Passed in rather than read here: both callers already resolve it, and
   * a later run compares this stamp to decide whether the block is stale.
   */
  readonly sdkVersion: string;
  /**
   * The frontend the scaffold actually wrote. Its guidance goes into `AGENTS.md`,
   * so an agent is told about the framework on disk rather
   * than whichever one happens to be the default. `null`: no frontend was written.
   */
  readonly frontend: FrontendPreset | null;
  /**
   * The theme the scaffold actually wrote. Its guidance is appended to the
   * frontend's in `AGENTS.md` — an agent that is not told which
   * tokens exist reaches for `bg-gray-100`, which looks right in the light-mode
   * screenshot and is unreadable in the dark one.
   */
  readonly theme?: ThemeChoice;
  /**
   * The overwrite decision, when the caller has already made it.
   *
   * `init --marketplace` has to: it writes a minimal `package.json` and runs
   * `npm install` BEFORE this call, so by the time `decideOverwrite` ran here
   * the directory would be non-empty — populated by this very command — and a
   * scaffold into a fresh directory would refuse itself. The caller decides
   * while the directory is still untouched and passes the answer down.
   */
  readonly overwrite?: Exclude<OverwriteMode, "refuse">;
  /**
   * Merge `package.json` with what is already on disk instead of replacing it,
   * and which side wins.
   *
   * `rendered`: the two-pass `init` path, where the file on disk is this run's
   * own minimal manifest plus what `npm install` added — see
   * {@link mergePackageJson}. `project`: an existing project, whose manifest is
   * the user's — see {@link mergeIntoProjectManifest}.
   *
   * It must be asked for rather than inferred from the filename: a new
   * project's manifest is written whole.
   */
  readonly mergePackageJson?: "rendered" | "project";
  /**
   * Under `mergePackageJson: "project"`: the scripts whose clash `--force`
   * confirmed, which take the rendered command over the project's.
   */
  readonly overrideScripts?: readonly string[];
  /**
   * npm's condensed reasons an earlier install in this run already warned
   * with. The project's own install failing with one of them says so in one
   * line instead of a second `init.install-failed` repeating the same text.
   */
  readonly reportedNpmFailures?: readonly string[];
  /**
   * `init --from` over an existing `xano/`: the `xano/`-relative files to remove,
   * already listed and confirmed by the caller. Given, it REPLACES the wholesale
   * clear — only what the previous decode wrote goes, and a file no decode wrote
   * stays, the way `generate --force` treats the same tree.
   */
  readonly xanoRemovals?: readonly string[];
}

/** The guidance `AGENTS.md` carries, keyed off whether `xano/` is regenerated. */
function guidanceMode(regenerable: boolean): GuidanceMode {
  return regenerable ? "generated" : "authored";
}

export interface ScaffoldResult {
  readonly mode: Exclude<OverwriteMode, "refuse">;
  readonly written: readonly string[];
  readonly install: InstallOutcome;
}

/** Whether a directory exists and holds anything at all (dotfiles included). */
export function isNonEmptyDir(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Decide what a run may overwrite, before a single byte is written.
 *
 * The marker is the whole basis for the no-`--force` refresh: its presence is
 * proof the directory's `xano/` was machine-written and already carries the
 * "regenerating overwrites this" warning. A directory holding anything else is
 * refused exactly as before.
 */
export function decideOverwrite(
  targetDir: string,
  opts: { force: boolean; regenerable: boolean },
): OverwriteMode {
  if (!isNonEmptyDir(targetDir)) return "full";
  if (opts.regenerable && existsSync(join(targetDir, CODEGEN_MARKER))) return "refresh-xano";
  return opts.force ? "full" : "refuse";
}

/** Read a previous run's marker, or `null` when there is none / it is unreadable. */
export function readMarker(targetDir: string): Record<string, unknown> | null {
  const path = join(targetDir, CODEGEN_MARKER);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    // A corrupt marker still proves the directory was machine-written; the
    // overwrite decision only checks existence, so this is not fatal.
    return null;
  }
}

/** Remove `xano/`, carrying the files that are not ours to destroy back over. */
function clearXanoDir(targetDir: string): void {
  const xanoDir = join(targetDir, XANO_DIR);
  if (!existsSync(xanoDir)) return;
  // SKIP the preserved files rather than deleting the directory and writing
  // them back. The restore window in a delete-then-restore is the one moment
  // when `xano/.env` exists only in this process's memory — a crash, a full
  // disk, or a throw in between destroys values that by design were never
  // written down anywhere else.
  //
  // Skipping also makes the whole class of non-content loss impossible rather
  // than merely handled: the file is never touched, so its mode, its mtime and
  // its inode survive for free. Restoring had to capture and re-apply the mode
  // explicitly, because `writeFileSync` creates through the umask — a 0600
  // secret came back 0644, silently, since the contents were right.
  //
  // This is the shape `pull-command.ts` already uses for the same job.
  for (const name of readdirSync(xanoDir)) {
    if (PRESERVED_ON_REFRESH.includes(name)) continue;
    const full = join(xanoDir, name);
    // A symlink is removed as the link it is. `rmSync` refuses one that points
    // at a directory, and recursing into it would delete the target's files —
    // outside the directory this is allowed to replace.
    if (lstatSync(full).isSymbolicLink()) unlinkSync(full);
    else rmSync(full, { recursive: true, force: true });
  }
}

/** The planned removals when the caller made them, else the wholesale clear. */
function replaceXanoDir(targetDir: string, removals: readonly string[] | undefined): void {
  if (removals === undefined) {
    clearXanoDir(targetDir);
    return;
  }
  const xanoDir = join(targetDir, XANO_DIR);
  removeFiles(xanoDir, removals);
  removeEmptiedDirs(xanoDir, removals);
}

/** Write one file, creating the directories it sits in. */
function writeFile(
  targetDir: string,
  file: ScaffoldFile,
  merge: ScaffoldOptions["mergePackageJson"],
  overrideScripts: readonly string[] = [],
): void {
  const full = join(targetDir, file.path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, fileContent(full, file, merge, overrideScripts), "utf8");
}

/** What {@link writeFile} writes at `full`: the file's own content, or a `package.json` merged with the one there. */
function fileContent(
  full: string,
  file: ScaffoldFile,
  merge: ScaffoldOptions["mergePackageJson"],
  overrideScripts: readonly string[],
): string {
  if (file.path !== "package.json" || merge === undefined) return file.content;
  if (merge === "rendered") return mergePackageJson(full, file.content);
  if (!existsSync(full)) return file.content;
  return mergeIntoProjectManifest(readFileSync(full, "utf8"), file.content, overrideScripts);
}

/** The `package.json` keys the backend merges into an existing project's manifest. */
const PROJECT_MERGED_MAPS = ["dependencies", "devDependencies"] as const;

/**
 * The backend's rendered `package.json` merged into an existing project's,
 * the project's own entries winning.
 *
 * Only what the backend needs takes part: the `xano:*` scripts, the
 * dependency maps, and the toolchain modules' `xanosdk` block. Everything else
 * the rendered manifest carries (`name`, `type`, `engines`) is the project's
 * to decide and is never added. An entry the project lacks is added; one it
 * has keeps its value — a dependency keeps the project's range. A script the
 * project defines with another command is a clash, refused before anything is
 * written; one in `overrideScripts` was confirmed under `--force` and takes
 * the rendered command.
 *
 * The `xanosdk` block merges per package with the rendered side winning, as it
 * does everywhere it is written: it holds this run's answers to the modules'
 * questions, which are the newer statement of intent.
 */
export function mergeIntoProjectManifest(
  existing: string,
  rendered: string,
  overrideScripts: readonly string[] = [],
): string {
  const project = JSON.parse(existing) as Record<string, unknown>;
  const ours = JSON.parse(rendered) as Record<string, unknown>;
  const scripts = asMap(project["scripts"]);
  for (const [name, command] of Object.entries(asMap(ours["scripts"]))) {
    if (!name.startsWith("xano:")) continue;
    if (!(name in scripts) || overrideScripts.includes(name)) scripts[name] = command;
  }
  if (Object.keys(scripts).length > 0) project["scripts"] = scripts;
  for (const key of PROJECT_MERGED_MAPS) {
    const theirs = asMap(project[key]);
    const added = { ...theirs };
    for (const [name, range] of Object.entries(asMap(ours[key]))) if (!(name in added)) added[name] = range;
    if (Object.keys(added).length === Object.keys(theirs).length) continue;
    // A map the project keeps in npm's order stays in it (npm's next install
    // would sort it anyway); one it keeps in its own order is appended to.
    project[key] = isSorted(Object.keys(theirs)) ? sortedKeys(added) : added;
  }
  const block = asMap(ours["xanosdk"]);
  if (Object.keys(block).length > 0) project["xanosdk"] = { ...asMap(project["xanosdk"]), ...block };
  return jsonLike(existing, project);
}

/**
 * `doc` written the way `existing` is written — its indentation, its line
 * endings, its final newline — so a diff of a merged project file shows the
 * merged lines and nothing else.
 */
function jsonLike(existing: string, doc: unknown): string {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const text = JSON.stringify(doc, null, jsonIndent(existing)).replace(/\n/g, eol);
  return /\r?\n$/.test(existing) ? text + eol : text;
}

/** The indentation a JSON document uses: a tab, or its first indented line's spaces (2 when it has none). */
function jsonIndent(text: string): string | number {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  if (indent === undefined) return 2;
  return indent.startsWith("\t") ? "\t" : indent.length;
}

/**
 * What adding the backend to an existing project would write over: each one
 * is refused unless `--force`, and all of them are found before anything is
 * written, so a refusal leaves the project as it was.
 *
 * - an existing `xano/` (`dir`);
 * - any other file the scaffold would write that is already there (`file`) —
 *   except the ones it merges into rather than writes ({@link MERGED_IN_EXISTING});
 * - a script the project defines under one of the backend's `xano:*` names
 *   with another command (`script`). The same command is no clash.
 */
export type Clash =
  | { readonly kind: "dir"; readonly path: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "script"; readonly name: string; readonly theirs: string; readonly ours: string };

/** The files an existing project's are merged into, never written over. */
export const MERGED_IN_EXISTING: ReadonlySet<string> = new Set([
  "package.json",
  ".gitignore",
  ".gitattributes",
  AGENTS_MD_PATH,
  ...MCP_CONFIGS.map((c) => c.path),
]);

/**
 * Every {@link Clash} between the backend's `files` and the project at
 * `targetDir`. Throws when the project's `package.json` cannot be read as JSON:
 * there is nothing to merge into, and replacing it is not this command's call.
 */
export function existingProjectClashes(targetDir: string, files: readonly ScaffoldFile[]): Clash[] {
  const clashes: Clash[] = [];
  const hasXano = existsSync(join(targetDir, XANO_DIR));
  if (hasXano) clashes.push({ kind: "dir", path: `${XANO_DIR}/` });
  for (const file of files) {
    if (MERGED_IN_EXISTING.has(file.path)) continue;
    if (hasXano && file.path.startsWith(`${XANO_DIR}/`)) continue;
    if (existsSync(join(targetDir, file.path))) clashes.push({ kind: "file", path: file.path });
  }
  const rendered = files.find((f) => f.path === "package.json");
  const manifestPath = join(targetDir, "package.json");
  // The merge rewrites the manifest in place, and a symlinked one usually belongs
  // to something else (a monorepo template, a shared config repo). `--force`
  // does not change that, so this is a refusal, not a clash.
  if (rendered !== undefined && linked(manifestPath)) {
    throw new UsageError(
      `${manifestPath} is a symlink, so init cannot merge the backend's scripts and dependencies into it ` +
        `without changing the file it points at. Replace the link with a regular file, then re-run; nothing was written.`,
    );
  }
  if (rendered === undefined || !existsSync(manifestPath)) return clashes;
  let theirs: Record<string, unknown>;
  try {
    theirs = asMap(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch (err) {
    throw new UsageError(
      `${manifestPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}), so init cannot ` +
        `merge the backend's scripts and dependencies into it. Fix it, then re-run; nothing was written.`,
    );
  }
  const scripts = asMap(theirs["scripts"]);
  for (const [name, ours] of Object.entries(asMap((JSON.parse(rendered.content) as Record<string, unknown>)["scripts"]))) {
    if (!name.startsWith("xano:") || !(name in scripts) || scripts[name] === ours) continue;
    clashes.push({ kind: "script", name, theirs: String(scripts[name]), ours: String(ours) });
  }
  return clashes;
}

/** One {@link Clash}, as a refusal or a `--force` listing names it. */
export function describeClash(clash: Clash): string {
  switch (clash.kind) {
    case "dir":
    case "file":
      return `${clash.path} already exists`;
    case "script":
      return `package.json script "${clash.name}" is \`${clash.theirs}\`; init's is \`${clash.ours}\``;
  }
}

/** `value` as a string-keyed map, or an empty one when it is not an object. */
function asMap(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/**
 * The rendered `package.json`, with what an earlier pass already put there
 * carried across.
 *
 * `init` writes this file TWICE for a project with modules: a minimal manifest
 * first, so `npm install` has something to install into, and the full rendered
 * one after. Between the two, npm has written real dependency entries and the
 * questionnaire has recorded plugin config — both of which a plain overwrite
 * would silently discard, leaving a project that names modules it no longer
 * depends on.
 *
 * Merged rather than skipped, because the rendered manifest is still the
 * authority on everything else: scripts, engines, the frontend's own deps. Only
 * the three keys an install or a plugin can write are carried forward, and the
 * rendered side wins a genuine conflict — it is the newer statement of what the
 * scaffold intends.
 */
function mergePackageJson(path: string, rendered: string): string {
  if (!existsSync(path)) return rendered;
  let existing: Record<string, unknown>;
  let next: Record<string, unknown>;
  try {
    existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    next = JSON.parse(rendered) as Record<string, unknown>;
  } catch {
    // An unparseable manifest on either side is not something to merge into.
    // The rendered one is known-good, so it wins outright.
    return rendered;
  }
  // The dependency maps, because they are what `npm install` wrote between the
  // two passes — and the `xanosdk` block, because it is what the PROJECT already
  // chose. All three are maps keyed by package name, and all three merge the
  // same way: an entry the existing manifest carries survives unless the
  // rendered one names that same key, in which case the rendered value wins as
  // the newer statement of intent.
  //
  // The block was once excluded here on the grounds that the rendered manifest
  // is its only writer (see `withXanoSdkBlock`). That is true of what `init`
  // COMPOSES and false of what is already on disk: a re-run only knows about
  // the modules it loaded this time, so dropping the rest silently deleted
  // another module's settings — including an `enabled: false`, which then came
  // back on, because absent config reads as enabled.
  for (const key of ["dependencies", "devDependencies", "xanosdk"] as const) {
    const before = existing[key];
    const after = next[key];
    if (typeof before !== "object" || before === null) continue;
    next[key] = typeof after === "object" && after !== null ? { ...before, ...after } : before;
  }
  return `${JSON.stringify(next, null, 2)}\n`;
}

/**
 * Install dependencies. A failure is non-fatal — the scaffold is still valid —
 * but the outcome is returned rather than swallowed, because the pull needs it:
 * verification loads the written tree, and "install failed" is the difference
 * between "cannot verify yet" and "the tree is broken".
 */
async function install(targetDir: string, reported: readonly string[]): Promise<InstallOutcome> {
  // Behind a spinner, like the add-on installs: npm's success narration is a
  // tree summary, a funding pitch and an audit count, none of which the reader
  // asked for. Captured rather than silenced — a failure prints npm's own
  // diagnosis, which is the only part anyone needs. `withSpinner` owns the
  // stop, including on a throw.
  const { manager, ignoreWorkspace } = detectInstallRoot(targetDir);
  const args = ["install", ...(ignoreWorkspace ? ["--ignore-workspace"] : [])];
  const result = await withSpinner(`Installing dependencies (${manager} ${args.join(" ")})`, () =>
    (manager === "npm" ? runNpmQuiet(args, targetDir) : runNpmQuiet(args, targetDir, { manager })),
  );
  if (result.status === 0) {
    success("Dependencies installed");
    return "installed";
  }
  // Named as the module installs name it: a range npm has no version for
  // (`ETARGET`), a package it does not have (`E404`) — under the warning, and
  // in its `--json` entry.
  // npm's reason rides the warning as its remedy lines, so the `--json` entry
  // carries it too; the run's ending line (init's) is no second warning of
  // the same failure (E2E pass 27: two `init.install-failed` entries).
  const cause = classifyNpmFailure(result.output, targetDir);
  const reason = condenseNpmError(result.output);
  if (reason !== "" && reported.some((earlier) => sameNpmFailure(earlier, reason))) {
    // The add-on install before it failed on this same answer from npm, and
    // its warning carries the reason (E2E pass 28: the ETARGET text twice).
    detail(`${manager} ${args.join(" ")} did not complete either — the same ${manager === "npm" ? "npm " : ""}error as above.`);
    return "failed";
  }
  warn(`${manager} ${args.join(" ")} did not complete — run it yourself in ${targetDir}.`, "init.install-failed", [
    ...(cause === undefined ? [] : [cause]),
    ...(reason === "" ? [] : [reason]),
  ]);
  return "failed";
}

/** Whether `path` is a symlink. `lstat`, not `existsSync`: a dangling link reads as absent and would be written through. */
function linked(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
}

/**
 * A symlinked AGENTS.md usually points at instructions shared across repos;
 * writing through it would put this project's brief into all of them.
 */
function agentsMdLinked(targetDir: string): boolean {
  return linked(join(targetDir, AGENTS_MD_PATH));
}

/**
 * The project files init merges a block into rather than owns. Like AGENTS.md,
 * a symlinked one points at a file other projects share, so it is left alone.
 */
const LINK_SKIPPED_MERGES: ReadonlySet<string> = new Set([".gitignore", ".gitattributes"]);

/**
 * The `AGENTS.md` a full write puts in `targetDir` — the managed brief upserted
 * into whatever is there — or undefined when it writes none (disabled, or a
 * symlink it leaves alone). Exported so a `--force` confirmation lists it by
 * the content that will actually land, not by the brief alone.
 */
export function plannedAgentsMd(
  targetDir: string,
  opts: Pick<ScaffoldOptions, "agentsMd" | "appName" | "regenerable" | "sdkVersion" | "frontend" | "theme">,
): ScaffoldFile | undefined {
  if (!opts.agentsMd || agentsMdLinked(targetDir)) return undefined;
  const agentsMdPath = join(targetDir, AGENTS_MD_PATH);
  const manager = detectInstallRoot(targetDir).manager;
  const rendered = renderAgentsMd(opts.appName, guidanceMode(opts.regenerable), {
    version: opts.sdkVersion,
    cli: projectFileCli(targetDir, manager),
    sdkDir: projectSdkDir(targetDir, manager),
    // `null` renders the brief with no frontend slots.
    frontend:
      opts.frontend === null
        ? null
        : {
            label: opts.frontend.label,
            section: opts.frontend.agentGuidanceSection(opts.theme?.icons),
            theme: opts.theme,
          },
  });
  // Upsert rather than overwrite: `--force` can point this at a directory
  // that already holds a hand-written AGENTS.md, and the user's own notes
  // are not ours to discard just because we have guidance to add.
  const existing = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, "utf8") : null;
  return { path: AGENTS_MD_PATH, content: upsertManagedBlock(existing, rendered) };
}


/**
 * The agent MCP configs a full write puts in `targetDir`: each declares the
 * {@link MCP_SERVER_NAME} server, which launches `xanosdk local mcp --stdio`
 * — no url and no token, since a restarted engine changes both.
 *
 * Merged by key, never rewritten: a config that declares other servers keeps
 * them, in the project's own indentation and line endings. One that already
 * declares this server is left alone (its args are the developer's choice),
 * and so is one that is not JSON, with the block to add by hand on stderr —
 * neither is a clash for `--force` to settle. Written alongside `AGENTS.md`
 * and skipped with it, under `--no-agents-md` / `--ai none`.
 */
export function plannedMcpConfigs(
  targetDir: string,
  opts: Pick<ScaffoldOptions, "agentsMd">,
  platform: NodeJS.Platform = process.platform,
): ScaffoldFile[] {
  if (!opts.agentsMd) return [];
  const manager = detectInstallRoot(targetDir).manager;
  const planned: ScaffoldFile[] = [];
  for (const config of MCP_CONFIGS) {
    const server = mcpServerCommand(targetDir, manager, {
      platform,
      ...(config.workspaceFolder === undefined ? {} : { workspaceFolder: config.workspaceFolder }),
    });
    const full = join(targetDir, config.path);
    // The leaf or the directory it sits in (`.cursor/`): either may point at a
    // config other projects share. Not the project itself, which a symlink may
    // well reach and which is this project's own.
    const parent = dirname(config.path);
    if (linked(full) || (parent !== "." && linked(join(targetDir, parent)))) {
      warn(`${config.path} is a symlink — left it and its target untouched.`, "merge.symlink");
      continue;
    }
    if (!existsSync(full)) {
      planned.push({ path: config.path, content: `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2)}\n` });
      continue;
    }
    const existing = readFileSync(full, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      info(
        `${config.path} is not valid JSON — left it alone. To connect agents to the Xano Engine, add this to its "mcpServers":\n` +
          `  "${MCP_SERVER_NAME}": ${JSON.stringify(server)}`,
      );
      continue;
    }
    const project = parsed as Record<string, unknown>;
    const declared = project["mcpServers"];
    if (declared !== undefined && (typeof declared !== "object" || declared === null || Array.isArray(declared))) {
      info(
        `${config.path} has an "mcpServers" that is not an object — left it alone. To connect agents to the Xano Engine, add this to it:\n` +
          `  "${MCP_SERVER_NAME}": ${JSON.stringify(server)}`,
      );
      continue;
    }
    const servers = asMap(declared);
    if (MCP_SERVER_NAME in servers) {
      detail(`${config.path} already declares ${MCP_SERVER_NAME} — left it as it is.`);
      continue;
    }
    project["mcpServers"] = { ...servers, [MCP_SERVER_NAME]: server };
    planned.push({ path: config.path, content: jsonLike(existing, project) });
  }
  return planned;
}

/**
 * The files a full write over `targetDir` changes: each one that exists and
 * would land with different bytes, sorted. What a `--force` confirmation lists —
 * a file rewritten to the bytes it already holds is not an overwrite worth asking about.
 */
export function changedOnDisk(targetDir: string, files: readonly ScaffoldFile[]): string[] {
  return files
    .filter((f) => {
      const full = join(targetDir, f.path);
      if (!existsSync(full)) return false;
      try {
        return readFileSync(full, "utf8") !== f.content;
      } catch {
        return true;
      }
    })
    .map((f) => f.path)
    .sort();
}

/**
 * Write a project into `targetDir`: decide, clear, write, install.
 *
 * Throws before writing anything when the target holds something this command
 * did not write and `--force` was not passed.
 */
export async function scaffoldProject(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const { targetDir, regenerable, force } = opts;
  const mode = opts.overwrite ?? decideOverwrite(targetDir, { force, regenerable });
  if (mode === "refuse") {
    throw new Error(
      `Target directory ${targetDir} is not empty. ` +
        `Re-run with --force to scaffold into it anyway.`,
    );
  }

  const files: ScaffoldFile[] = [...opts.files];
  if (mode === "full" && opts.agentsMd && agentsMdLinked(targetDir)) {
    warn(`${AGENTS_MD_PATH} is a symlink — left it and its target untouched.`, "agents.symlink");
  }
  if (mode === "full") {
    const agents = plannedAgentsMd(targetDir, opts);
    if (agents !== undefined) files.push(agents);
    files.push(...plannedMcpConfigs(targetDir, opts));
    // A previous tree's files would survive an in-place overwrite and stay inside
    // the root tsconfig's `include`, so `npm run build` would typecheck orphans
    // importing symbols the new barrel no longer exports.
    if (regenerable) replaceXanoDir(targetDir, opts.xanoRemovals);
  } else {
    replaceXanoDir(targetDir, opts.xanoRemovals);
  }

  const writing =
    mode === "refresh-xano"
      ? files.filter((f) => f.path === XANO_DIR || f.path.startsWith(`${XANO_DIR}/`))
      : files;

  mkdirSync(targetDir, { recursive: true });
  const written: string[] = [];
  for (const file of writing) {
    if (LINK_SKIPPED_MERGES.has(file.path) && linked(join(targetDir, file.path))) {
      warn(`${file.path} is a symlink — left it and its target untouched.`, "merge.symlink");
      continue;
    }
    writeFile(targetDir, file, opts.mergePackageJson, opts.overrideScripts);
    detail(file.path);
    written.push(file.path);
  }
  success(
    mode === "refresh-xano"
      ? `Refreshed ${XANO_DIR}/ — ${writing.length} files (the rest of the project was left alone)`
      : `Wrote ${written.length} files`,
  );

  // A refresh into a project whose dependencies are already installed has
  // nothing to install; a first run always does, because verification (and
  // `npm run build`) need them.
  const alreadyInstalled = existsSync(join(targetDir, "node_modules"));
  const outcome: InstallOutcome = opts.noInstall
    ? "skipped"
    : mode === "refresh-xano" && alreadyInstalled
      ? "already-installed"
      : await install(targetDir, opts.reportedNpmFailures ?? []);

  return { mode, written, install: outcome };
}

/** Resolve a target-directory argument to an absolute path. */
export function resolveTarget(arg: string): string {
  return resolve(arg);
}
