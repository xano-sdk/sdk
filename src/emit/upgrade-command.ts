/**
 * `xanosdk upgrade` — the deliberate half of the update story.
 *
 * The CLI already notices when it is behind: `maybeNotifyUpdate()` prints a
 * nudge at the end of every run. That mechanism is correctly timid — silent in
 * CI, silent off a TTY, cached for an hour, and it swallows every error — and
 * every property that makes it a good notifier makes it useless as an ANSWER.
 * This command asks the question on purpose: `--check` reports and exits 7 so a
 * script can branch on it, and the bare form installs.
 *
 * Two things it reconciles that npm alone gets wrong, both scoped to a local
 * install because a global one has no project to reconcile:
 *
 *   • `npm i -D @xano/sdk@1.0.4` writes `^1.0.4`, but the scaffold writes
 *     `>=1.0.4 <2.0.0`, so the manifest keeps one shape whichever tool wrote
 *     the range. See `sdkDep()`.
 *   • The agent guidance managed blocks stay stamped with the version that
 *     scaffolded them, which defeats the reason version-matched docs ship
 *     inside the package at all.
 *
 * Both are courtesies AFTER the install succeeded, so neither can turn a
 * successful upgrade into a failed command.
 *
 * Node-only (node:fs + the npm spawn); lazily imported from `cli.ts` so the
 * browser-safe authoring bundle never pulls it in.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { readEnvVar } from "../util/env.js";
import { isMachineOutput, writeJson } from "./output.js";
import { runNpmQuiet, runNpmStreaming } from "./npm.js";
import { trackLocalWrite } from "../util/sent-writes.js";
import { assertProjectDir } from "./project-dir.js";
import { blank, detail, step, style, success, terminalText, warn } from "./ui.js";
import {
  checkForUpgrade,
  detectInstallMode,
  registryUrl,
  runFromPackageRunner,
  suppressUpdateNotice,
  type CheckResult,
  type PackageRunner,
} from "./update-check.js";
// Imported EAGERLY, unlike the lazy per-command imports elsewhere in the CLI:
// the apply path replaces the very package this module was loaded from, so
// anything resolved after the npm spawn would be resolved against a directory
// npm has just swapped out. Everything the post-install path needs is bound
// before the spawn happens.
import { sdkDep } from "./init-templates.js";
import { refreshAgentFiles } from "./agent-file-refresh.js";
import { readVersion } from "./cli.js";
import { installedSdk, projectSdkVersion } from "./project-sdk.js";
import { detectPackageManager, type PackageManager } from "./package-manager.js";
import { prepareInstallSite, refusePlugAndPlay } from "./project-dependency.js";
import { retryCommand } from "./retry-command.js";
import { CliError } from "./errors.js";
import { EXIT_SOURCE_UNRESOLVABLE } from "./source-selector.js";

/**
 * `--check` found a newer version. Distinct from a failure (1) because nothing
 * went wrong, and distinct from success (0) because a caller scripting
 * `xanosdk upgrade --check` is asking a yes/no question and wants the answer in
 * `$?`. Deliberately NOT set on the apply path: "an upgrade was available and I
 * installed it" is a success.
 *
 * 2–6 are already spoken for (validate/codegen-verify, static, microservice,
 * tests, tests-unreachable) and 130 is SIGINT.
 */
const EXIT_UPGRADE_AVAILABLE = 7;

/** The package this command upgrades — the one name npm ever hears from here. */
const PACKAGE = "@xano/sdk";

export async function runUpgradeCommand(args: ParsedArgs): Promise<void> {
  // Silence the end-of-run nudge for this run. This command is the one that
  // talks about versions, and the notifier that fires after it reads a cache
  // this very command just refreshed — so on the reachable case of a GLOBAL
  // binary upgrading a project-local dependency (which is what
  // `detectInstallMode` reports for any scaffolded project), it would append
  // "a new @xano/sdk is available" directly beneath "Upgraded to 99.0.0".
  // Called before any output, so no early return can outrun it.
  suppressUpdateNotice();

  // The newly installed CLI, spawned by the one that installed it, reconciles
  // what is derived from the package (see `reconcileWithInstalled`) — with its
  // own templates, not the old ones of the process that ran npm.
  if (process.env[RECONCILE_ENV] === "1") {
    writeJson({ status: "reconciled", reconciled: await reconcileDerived(process.cwd(), readVersion()) });
    return;
  }

  // Mode first, because it decides WHICH copy is being upgraded — and therefore
  // which version the registry should be compared against. `readVersion()` is
  // the running binary, which for a global CLI operating on a project-local
  // dependency is a different package entirely: comparing it would refuse an
  // upgrade the project needs ("you are current") or report one that never
  // lands, run after run.
  const mode = detectInstallMode();
  // The project the install resolved from — its root, from a subdirectory too,
  // as every other command finds it.
  const dir = mode === "local" ? sdkProjectDir(process.cwd()) : process.cwd();
  // A CLI that npx (or pnpm dlx, yarn dlx, bunx) fetched is a temporary copy,
  // not an install: upgrading "globally" from it would add or replace a global
  // CLI the user never ran, and installing into the package at hand would add
  // a dependency it never declared. Only a project that declares @xano/sdk
  // and has it installed is upgraded from a runner's copy. An explicit
  // `XANOSDK_INSTALL_MODE` still decides.
  const runner = readEnvVar("XANOSDK_INSTALL_MODE")?.trim() ? undefined : runFromPackageRunner();
  if (runner !== undefined && !(mode === "local" && declaresSdk(dir))) {
    reportRunnerCopy(args, runner);
    return;
  }
  const installed = mode === "local" ? projectSdkVersion(dir) : undefined;

  const result = await checkForUpgrade(installed === undefined ? undefined : { current: installed });
  if (result.status === "unknown") {
    const message = explainUnknown(result, retryCommand(args, { command: "upgrade" }).command);
    // A registry that answered with an error, or did not answer: a transport
    // failure, exit 8 like every other one. A refused credential, a registry
    // URL that is not one and an unreadable installed version are the run's
    // own setup to fix.
    if (result.reason === "registry" && result.refused === undefined) {
      throw new CliError("SDK_ERROR", message, { exitCode: EXIT_SOURCE_UNRESOLVABLE });
    }
    throw new Error(message);
  }

  if (result.status === "current") {
    // Current, and still reconciled: an upgrade run by an older CLI left the
    // agent guidance and the route table rendered by that CLI. `--check` writes nothing.
    // A caret written by a hand `npm install @xano/sdk` is npm's spelling
    // just as after an upgrade, so it is restored here too.
    const ownRange = mode === "local" && !args.check && installed !== undefined && existsSync(join(dir, "package.json"));
    const reconciled = [
      ...(ownRange ? restoreSdkRangeSafely(dir, installed) : []),
      ...(ownRange && installed === readVersion() ? [...syncLockToManifest(dir), ...(await reconcileDerived(dir, installed))] : []),
    ].filter((path, at, all) => all.indexOf(path) === at);
    // The outcome line on stderr either way: a piped run's reader sees what happened too.
    success(`@xano/sdk ${style.bold(result.current)} is the latest published version.`);
    for (const path of reconciled) detail(`reconciled ${path}`);
    if (isMachineOutput(args)) {
      writeJson({ status: "current", current: result.current, latest: result.latest, installMode: mode, reconciled });
    }
    return;
  }

  // Newer than anything published: there is nothing to upgrade to, and the
  // bare form must not "upgrade" to `latest` — that would be a downgrade.
  // Exit 0, like "current": exit 7 means an upgrade is available.
  if (result.status === "ahead") {
    success(
      `@xano/sdk ${style.bold(result.current)} is ahead of the latest published version ` +
        `(${result.latest}) — nothing to upgrade.`,
    );
    if (isMachineOutput(args)) {
      writeJson({ status: "ahead", current: result.current, latest: result.latest, installMode: mode });
    }
    return;
  }

  if (args.check) {
    // The outcome line on stderr either way, as "current" says its own: a piped
    // run's reader sees the answer, not only an exit code.
    warn(
      `A new @xano/sdk is available: ${style.dim(result.current)} → ${style.green(result.latest)}`,
      "update.available",
      [`run \`xanosdk upgrade\`, or: ${suggestedCommand(dir, mode, result.latest)}`],
    );
    if (isMachineOutput(args)) {
      writeJson({
        status: "available",
        current: result.current,
        latest: result.latest,
        installMode: mode,
        command: suggestedCommand(dir, mode, result.latest),
      });
    }
    process.exitCode = EXIT_UPGRADE_AVAILABLE;
    return;
  }

  await applyUpgrade(args, dir, result.current, result.latest, mode);
}

/** `upgrade` run from a package runner's copy outside an SDK project: nothing is installed, so nothing changes. */
function reportRunnerCopy(args: ParsedArgs, runner: PackageRunner): void {
  const current = readVersion();
  success(`Nothing to upgrade: @xano/sdk ${style.bold(current)} is a temporary copy a package runner (${runner}) fetched, not an install.`);
  detail(
    `\`${runner} @xano/sdk@latest <command>\` runs the newest release; \`${runner} @xano/sdk@<version> <command>\` pins one.\n` +
      `In a project, run \`xanosdk upgrade\` there. A global CLI upgrades with \`npm i -g ${PACKAGE}@latest\`.`,
  );
  if (isMachineOutput(args)) writeJson({ status: "not-installed", current, installMode: "runner" });
}

/**
 * The npm line a user could run by hand instead.
 *
 * Block-aware, unlike the notifier's `upgradeCommand()`: suggesting a bare `-D`
 * to someone whose SDK sits in `dependencies` would tell them to relocate it.
 * The notifier cannot afford this read; a command the user typed can.
 *
 * Pinned to the version the check found, for the reason {@link applyUpgrade}
 * gives.
 */
function suggestedCommand(dir: string, mode: "global" | "local", latest: string): string {
  if (mode === "global") return `npm i -g ${PACKAGE}@${latest}`;
  const manager = detectPackageManager(dir);
  const dev = saveFlagFor(dir) === "--save-dev";
  if (manager === "npm") return `npm i ${saveFlagFor(dir)} ${PACKAGE}@${latest}`;
  return `${manager} add ${dev ? (manager === "pnpm" ? "--save-dev " : "--dev ") : ""}${PACKAGE}@${latest}`;
}

/**
 * Why the check could not answer. Two genuinely different problems, so two
 * genuinely different messages — telling someone with a git build to check
 * their network would send them looking in the wrong place.
 */
function explainUnknown(result: Extract<CheckResult, { status: "unknown" }>, rerun: string): string {
  // Continuation lines are plain: the failure renderer indents them under `✗`.
  if (result.reason === "registry-url") {
    return (
      `XANOSDK_UPDATE_REGISTRY is ${JSON.stringify(registryUrl())}, which is not an http(s) URL, ` +
      `so no registry was asked.\n` +
      `Set it to a registry's http(s) URL for @xano/sdk's latest manifest, or unset it to use the npm registry.`
    );
  }
  if (result.reason === "registry" && result.refused !== undefined) {
    return (
      `The npm registry at ${registryUrl()} refused ${
        result.refused === "credential" ? "the credential your npm config holds for it" : "an unauthenticated read"
      } (${result.answered}).\n` +
      (result.refused === "credential"
        ? `Renew the \`//<registry host>/:_authToken\` (or \`_auth\`) line in your .npmrc — \`npm view @xano/sdk version\` reads with the same one.`
        : `Add a \`//<registry host>/:_authToken=…\` line for it to your .npmrc (or \`npm login --registry <url>\`), as npm itself needs.`)
    );
  }
  if (result.reason === "registry" && result.answered !== undefined) {
    return (
      `The npm registry at ${registryUrl()} answered with ${result.answered}, ` +
      `so there is no latest version to compare against.\n` +
      `Run \`${rerun}\` again later, or point XANOSDK_UPDATE_REGISTRY at a working mirror.`
    );
  }
  return result.reason === "registry"
    ? `Could not reach the npm registry at ${registryUrl()}.\n` +
        `Check your connection and run \`${rerun}\` again, or point XANOSDK_UPDATE_REGISTRY at a reachable mirror.`
    : `Could not resolve the installed @xano/sdk version, so there is ` +
        `nothing to compare against.\n` +
        `This is expected for a git build or a linked checkout — upgrade with npm directly.`;
}

/**
 * Install the new version, then reconcile what npm left behind.
 *
 * npm is asked for the exact version the check found, never the `latest` tag:
 * the check reads the registry live, but npm resolves `latest` from its own
 * metadata cache, which lags a fresh release. Asking for the tag installs the
 * previous version while this command reports the new one and writes a range
 * that excludes what is in `node_modules`. `--prefer-online` makes npm
 * revalidate that cache first, so a stale copy cannot report the exact version
 * as nonexistent either.
 */
async function applyUpgrade(
  args: ParsedArgs,
  dir: string,
  current: string,
  latest: string,
  mode: "global" | "local",
): Promise<void> {
  if (mode === "local") {
    assertProjectDir(dir, {
      what: "`xanosdk upgrade` installs into a Xano SDK project",
      remedy:
        "cd into your project first, or set XANOSDK_INSTALL_MODE=global to upgrade the global CLI.",
    });
  }

  // Aimed at the project as every dependency change is: an npm workspace
  // member from the root (linked into its lockfile first), a project pnpm would
  // resolve to an enclosing workspace with --ignore-workspace.
  let scope: readonly string[] = [];
  let cwd = dir;
  if (mode === "local") {
    refusePlugAndPlay(dir, retryCommand(args, { command: "upgrade" }).command);
    const { site, link } = await prepareInstallSite(dir);
    if (link !== null && link.status !== 0) {
      process.stderr.write(terminalText(link.output.trimEnd()) + "\n");
      throw new Error(`Nothing was upgraded: this project could not be linked into its npm workspace (exit ${link.status}).`);
    }
    scope = site.scope;
    cwd = site.cwd;
  }

  step(`Upgrading ${style.bold(PACKAGE)} ${style.dim(current)} → ${style.green(latest)}`);
  const manager: PackageManager = mode === "local" ? detectPackageManager(dir) : "npm";
  // From the install on, an interrupt may land over a project that already
  // holds the new version: said, with the read that settles it and the re-run
  // that finishes the range and the refresh.
  const ls = manager === "npm" ? `\`npm ls${mode === "global" ? " -g" : ""} ${PACKAGE}\`` : `the ${PACKAGE} entry in package.json`;
  const check = `Check ${ls}, then run \`${retryCommand(args, { command: "upgrade" }).command}\` again — it finishes what the install left.`;
  await trackLocalWrite({ what: `the upgrade to ${PACKAGE} ${latest}`, check }, () =>
    installAndReconcile(args, dir, current, latest, mode, manager, scope, cwd),
  );
}

/** {@link applyUpgrade}'s install and everything after it. */
async function installAndReconcile(
  args: ParsedArgs,
  dir: string,
  current: string,
  latest: string,
  mode: "global" | "local",
  manager: PackageManager,
  scope: readonly string[],
  cwd: string,
): Promise<void> {
  let undo = (): void => {};
  let ran: string;
  if (manager === "npm") {
    const flag = mode === "global" ? "-g" : saveFlagFor(dir);
    // npm's summary goes to stdout, and so does our JSON document — route npm's
    // to stderr so a piped run stays parseable.
    const spec = `${PACKAGE}@${latest}`;
    ran = ["npm", "i", flag, spec, ...scope].join(" ");
    const status = await runNpmStreaming(["i", flag, spec, "--prefer-online", ...scope], cwd, { stdout: "stderr" });
    if (status !== 0) {
      // npm has already printed why, in more detail than we could summarize. And
      // nothing is reconciled after a failed install: a half-installed tree should
      // not also get its package.json rewritten.
      throw new Error(`${ran} failed (exit ${status}).`);
    }
  } else {
    ran = [manager, "install", ...scope].join(" ");
    undo = await installWithManager(manager, dir, latest, scope);
  }

  // What the install actually put in the project, not what was asked for: the
  // range written below must contain it, or `npm ls` and the next `npm ci` fail.
  // Read from disk, through the link a pnpm `node_modules` holds — never
  // through the module resolver, which answers with the copy it resolved
  // before the install.
  const installed = (mode === "local" ? installedSdk(dir)?.version : undefined) ?? latest;
  // A manager that exited 0 and left the version this run started from did
  // not upgrade anything.
  if (installed === current && current !== latest) {
    undo();
    throw new Error(
      `\`${ran}\` exited 0, but this project still has ${PACKAGE} ${current} — ${latest} was not installed` +
        (manager === "npm" ? "." : `, and package.json is back as it was.`) +
        ` What ${manager} printed above says why.`,
    );
  }
  const reconciled = mode === "local" ? reconcileProject(dir, installed, manager) : [];

  blank();
  success(`Upgraded to @xano/sdk ${style.bold(installed)}.`);
  for (const path of reconciled) detail(`reconciled ${path}`);
  if (isMachineOutput(args)) {
    writeJson({ status: "upgraded", current, latest, installed, installMode: mode, reconciled });
  }
}

/**
 * The upgrade under pnpm, yarn or bun: the scaffold's range for `latest`
 * written into package.json in the block that already holds the SDK, then the
 * manager's own install — which re-resolves the one dependency whose range its
 * lockfile no longer satisfies and writes its own lockfile, never npm's. A
 * failed install puts package.json back as it was; the returned function does
 * the same for an install the caller finds did not land.
 */
async function installWithManager(manager: PackageManager, dir: string, latest: string, scope: readonly string[]): Promise<() => void> {
  const manifest = join(dir, "package.json");
  const raw = readFileSync(manifest, "utf8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const block = sdkBlock(pkg) ?? "devDependencies";
  const deps = (typeof pkg[block] === "object" && pkg[block] !== null ? pkg[block] : (pkg[block] = {})) as Record<string, string>;
  deps[PACKAGE] = sdkDep(latest);
  writeFileSync(manifest, JSON.stringify(pkg, null, indentOf(raw)) + (raw.endsWith("\n") ? "\n" : ""));
  const status = await runNpmStreaming(["install", ...scope], dir, { stdout: "stderr", manager });
  if (status !== 0) {
    writeFileSync(manifest, raw);
    throw new Error(`\`${[manager, "install", ...scope].join(" ")}\` failed (exit ${status}) after package.json asked for ${PACKAGE} ${sdkDep(latest)}; package.json is back as it was.`);
  }
  return () => writeFileSync(manifest, raw);
}

/**
 * Undo what npm's defaults got wrong, then have the NEW CLI reconcile what is
 * derived from the package.
 *
 * Every step is best-effort: the install has already succeeded, and a courtesy
 * that fails should warn rather than retroactively fail the upgrade. Returns the
 * paths it actually changed, so the caller can say what happened rather than
 * claiming a reconciliation that no-oped.
 */
function reconcileProject(dir: string, version: string, manager: PackageManager): string[] {
  const changed: string[] = [];
  try {
    // Another manager installed the scaffold's range as written, and its lockfile records that range.
    if (manager === "npm") changed.push(...restoreSdkRange(dir, version));
  } catch (err) {
    warn(`Could not restore the ${PACKAGE} range in package.json: ${messageOf(err)}`, "upgrade.partial");
  }
  changed.push(...reconcileWithInstalled(dir));
  return changed;
}

/**
 * {@link restoreSdkRange} for a project that is already current, warning
 * rather than failing a command whose answer stands.
 */
function restoreSdkRangeSafely(dir: string, version: string): string[] {
  try {
    // Only npm's own spellings (`^1.0.4`, `1.0.4`); a range someone chose stays.
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    const block = sdkBlock(pkg);
    const range = block === undefined ? undefined : (pkg[block] as Record<string, unknown>)[PACKAGE];
    if (typeof range !== "string" || !/^\^?\d+\.\d+\.\d+$/.test(range)) return [];
    return restoreSdkRange(dir, version);
  } catch (err) {
    warn(`Could not restore the ${PACKAGE} range in package.json: ${messageOf(err)}`, "upgrade.partial");
    return [];
  }
}

/** Set on the installed CLI the upgrade spawns: reconcile derived files, nothing else. */
const RECONCILE_ENV = "XANOSDK_UPGRADE_RECONCILE";

/**
 * Run the newly installed CLI over the project to refresh what is rendered
 * from the package — the agent guidance, the README footer and the route
 * table. This process is the OLD CLI: its templates rendered AGENTS.md as the
 * previous version wrote it, and stamping the new version on that text left a
 * block no later refresh saw as stale. When the new CLI cannot be run, the
 * step to take is named.
 */
export function reconcileWithInstalled(dir: string): string[] {
  const again =
    "Run `xanosdk upgrade` once more — the new CLI then refreshes AGENTS.md, the README's Built-with footer, the .env.example template and the route table (`npm run xano:routes`); commit what changes.";
  const bin = installedBin(dir);
  if (bin === undefined) {
    warn(`Could not find the installed ${PACKAGE} CLI to refresh what it renders.`, "upgrade.partial", [again]);
    return [];
  }
  const res = spawnSync(process.execPath, [bin, "upgrade", "--json"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, [RECONCILE_ENV]: "1" },
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 120_000,
  });
  try {
    const doc = JSON.parse(res.stdout) as { status?: unknown; reconciled?: unknown };
    if (res.status === 0 && doc.status === "reconciled" && Array.isArray(doc.reconciled)) {
      return doc.reconciled.filter((p): p is string => typeof p === "string");
    }
  } catch {
    /* not the document — said below */
  }
  warn(`The installed ${PACKAGE} CLI did not refresh what it renders (exit ${res.status ?? "none"}).`, "upgrade.partial", [again]);
  return [];
}

/**
 * The `xanosdk` bin of the project's installed `@xano/sdk`, by its package's
 * `bin` field — found on disk as it is NOW, through any link: the module
 * resolver would answer with the copy it resolved before the install, and
 * under pnpm that old copy is still in the store.
 */
function installedBin(dir: string): string | undefined {
  try {
    const found = installedSdk(dir);
    const linked = found === undefined ? undefined : join(found.root, "node_modules", ...PACKAGE.split("/"), "package.json");
    const manifest =
      linked !== undefined && existsSync(linked)
        ? realpathSync(linked)
        : createRequire(join(dir, "package.json")).resolve(`${PACKAGE}/package.json`);
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: unknown };
    const rel = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin as Record<string, unknown> | undefined)?.xanosdk;
    if (typeof rel !== "string") return undefined;
    const bin = join(dirname(manifest), rel);
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What THIS CLI renders into the project, brought up to it: the agent guidance
 * block and the README's footer, the lambda modules' type-check config, the
 * `.env.example` template, and the route table the scaffold's `xano:routes`
 * script generates — `xano:check` fails on a stale template or route table.
 * Run by the installed CLI after an upgrade, and by `upgrade` when already
 * current.
 */
async function reconcileDerived(dir: string, version: string): Promise<string[]> {
  const changed: string[] = [];
  try {
    // `explicit`: the user typed this command, so the notifier-style CI and
    // agent-detection gates do not apply. The invariants that protect the tree —
    // never create a file, never add a block to a file that lacks one — are not
    // part of that bypass and still hold.
    changed.push(...refreshAgentFiles({ projectDir: dir, sdkVersion: version, explicit: true }));
  } catch (err) {
    warn(`Could not refresh the agent guidance blocks: ${messageOf(err)}`, "upgrade.partial");
  }
  try {
    const { reconcileLambdaConfig } = await import("./lambda-config-reconcile.js");
    const lambdas = reconcileLambdaConfig(dir);
    changed.push(...lambdas.changed);
    if (lambdas.manual.length > 0) {
      warn(
        "The lambda modules in xano/lambdas type-check under their own tsconfig, which loads the lambda runtime's globals — finish the steps this upgrade left to you:",
        "upgrade.partial",
        lambdas.manual,
      );
    }
  } catch (err) {
    warn(`Could not set up the xano/lambdas type-check: ${messageOf(err)}`, "upgrade.partial");
  }
  try {
    changed.push(...(await rerenderEnvTemplate(dir)));
  } catch (err) {
    warn(`Could not re-render the .env.example template: ${messageOf(err)}`, "upgrade.partial");
  }
  changed.push(...(await regenerateRoutes(dir)));
  return changed;
}

/**
 * The backend's `.env.example`, re-rendered in this version's words for the
 * names it already lists — what the next export would write, so `export
 * --check` does not call a template drifted that only the SDK's text changed in.
 * A hand-written file (not the SDK's) is left alone.
 */
async function rerenderEnvTemplate(dir: string): Promise<string[]> {
  const { backendDirIn } = await import("./backend-dir.js");
  const { rerenderEnvExample } = await import("./env-example-refresh.js");
  const path = join(backendDirIn(dir), ".env.example");
  if (!existsSync(path)) return [];
  const current = readFileSync(path, "utf8");
  const names = [...current.matchAll(/^# ([A-Za-z_][A-Za-z0-9_]*)=$/gm)].map((m) => m[1]!);
  const next = rerenderEnvExample(current, names);
  if (next === undefined || next === current) return [];
  writeFileSync(path, next);
  return [relative(dir, path).split(sep).join("/")];
}

/**
 * The scaffold's route table, regenerated by its own script when the project
 * has one. Its output is captured — the script's own document is not this
 * command's — and printed only when it fails, as the reason.
 */
async function regenerateRoutes(dir: string): Promise<string[]> {
  let script: unknown;
  try {
    script = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts?.["xano:routes"];
  } catch {
    return [];
  }
  if (typeof script !== "string") return [];
  const target = /--emit[= ](\S+)/.exec(script)?.[1] ?? "xano/routes.gen.ts";
  const path = join(dir, target);
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const { status, output } = await runNpmQuiet(["run", "--silent", "xano:routes"], dir);
  if (status !== 0) {
    if (output.trim() !== "") process.stderr.write(terminalText(output.endsWith("\n") ? output : `${output}\n`));
    warn(`\`npm run xano:routes\` failed (exit ${status}), so ${target} was not regenerated.`, "upgrade.partial", [
      "Fix what it printed, then run `npm run xano:routes` and commit the result.",
    ]);
    return [];
  }
  const after = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  return after !== before ? [target] : [];
}

/**
 * Rewrite the project's `@xano/sdk` range from npm's caret back to the
 * scaffold's, in place.
 *
 * Surgical on purpose. It edits the one range string and re-serializes with the
 * same 2-space indent and trailing newline the scaffold writes, so a
 * reconciliation nobody asked to see produces a one-line diff. It also does not
 * MOVE the entry: a project that deliberately keeps the SDK in `dependencies`
 * keeps it there.
 *
 * Returns the files it wrote, so an already-correct range is a silent no-op
 * rather than a reported change.
 */
function restoreSdkRange(dir: string, version: string): string[] {
  const manifest = join(dir, "package.json");
  const raw = readFileSync(manifest, "utf8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;

  const block = sdkBlock(pkg);
  // Not a dependency of this project at all — nothing to reconcile. Reachable
  // when `detectInstallMode()` said local for a reason other than a direct
  // dependency (a hoisted monorepo root, say).
  if (block === undefined) return [];

  const deps = pkg[block] as Record<string, string>;
  const want = sdkDep(version);
  const changed: string[] = [];
  if (deps[PACKAGE] !== want) {
    deps[PACKAGE] = want;
    writeFileSync(manifest, JSON.stringify(pkg, null, indentOf(raw)) + (raw.endsWith("\n") ? "\n" : ""));
    changed.push("package.json");
  }
  if (restoreLockRange(dir, block, want)) changed.push("package-lock.json");
  return changed;
}

/** package-lock.json's root range brought to package.json's, whatever wrote either. */
function syncLockToManifest(dir: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    const block = sdkBlock(pkg);
    if (block === undefined) return [];
    const range = (pkg[block] as Record<string, unknown>)[PACKAGE];
    return typeof range === "string" && restoreLockRange(dir, block, range) ? ["package-lock.json"] : [];
  } catch (err) {
    warn(`Could not bring package-lock.json's ${PACKAGE} range to package.json's: ${messageOf(err)}`, "upgrade.partial");
    return [];
  }
}

/**
 * The lockfile's copy of the root range, kept equal to package.json's: npm
 * wrote its caret there too, and a lock that disagrees with the manifest is
 * rewritten by the next `npm install` — churn in a file nobody touched.
 */
function restoreLockRange(dir: string, block: "dependencies" | "devDependencies", want: string): boolean {
  const lockPath = join(dir, "package-lock.json");
  if (!existsSync(lockPath)) return false;
  const raw = readFileSync(lockPath, "utf8");
  const lock = JSON.parse(raw) as { packages?: Record<string, Record<string, unknown>> };
  const root = lock.packages?.[""];
  const deps = root?.[block] as Record<string, string> | undefined;
  if (deps === undefined || !(PACKAGE in deps) || deps[PACKAGE] === want) return false;
  deps[PACKAGE] = want;
  writeFileSync(lockPath, JSON.stringify(lock, null, indentOf(raw)) + (raw.endsWith("\n") ? "\n" : ""));
  return true;
}

/** Which dependency block already holds the SDK, if either does. */
/** Whether `dir`'s package.json lists `@xano/sdk` as a dependency. */
function declaresSdk(dir: string): boolean {
  try {
    return sdkBlock(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>) !== undefined;
  } catch {
    return false;
  }
}

function sdkBlock(pkg: Record<string, unknown>): "dependencies" | "devDependencies" | undefined {
  return (["devDependencies", "dependencies"] as const).find((key) => {
    const deps = pkg[key];
    return typeof deps === "object" && deps !== null && PACKAGE in (deps as object);
  });
}

/**
 * The npm save flag that keeps the SDK in the block it is already in.
 *
 * A hardcoded `-D` does not merely fail to move it — npm actively RELOCATES a
 * `dependencies` entry into `devDependencies`, which silently drops the package
 * from `npm ci --omit=dev`. Defaults to `-D` when the SDK is not yet a listed
 * dependency, matching what the scaffold writes.
 */
function saveFlagFor(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return sdkBlock(pkg) === "dependencies" ? "--save-prod" : "--save-dev";
  } catch {
    return "--save-dev";
  }
}

/**
 * The manifest's own indentation, so a one-line change stays a one-line diff.
 * `JSON.stringify` with a fixed `2` would reformat every line of a tab- or
 * four-space-indented file.
 */
function indentOf(raw: string): string | number {
  return /^(\t+)"/m.exec(raw)?.[1] ?? /^( +)"/m.exec(raw)?.[1]?.length ?? 2;
}

/**
 * The nearest directory at or above `start` whose package.json depends on
 * `@xano/sdk` — the project an upgrade installs into — else the nearest
 * with a package.json, else `start`.
 */
function sdkProjectDir(start: string): string {
  let nearest: string | undefined;
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      nearest ??= dir;
      try {
        if (sdkBlock(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>) !== undefined) return dir;
      } catch {
        return dir;
      }
    }
    if (dirname(dir) === dir) return nearest ?? start;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
