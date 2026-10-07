/**
 * `xanosdk init [<dir>] [--from <source>] [--web]` — scaffold a ready-to-run
 * Xano SDK project: a Vite
 * frontend under `frontend/` and a Xano SDK-authored backend under `xano/`,
 * wired with `dev`/`build`/`xano:export`/`xano:deploy`/`xano:deploy:ephemeral` scripts. The starter
 * backend is empty but valid (it compiles and deploys with zero domain code);
 * the walkthrough for the first table/endpoint lives in comments and
 * `xano/EXAMPLE.md`.
 *
 * Which framework fills `frontend/` is a `FrontendPreset` (see
 * `frontend-presets.ts`). `--framework <id>` selects it non-interactively; in a
 * TTY with no flag, `init` prompts; otherwise React. `--framework none` (or "No
 * frontend" at the prompt) writes the backend alone.
 *
 * That is for an empty or missing directory. Any other directory is an EXISTING
 * project ({@link InitMode}): it already has its own app, so `init` adds the
 * backend only — `xano/`, and what the backend needs merged into the files the
 * project already has — with no prompt, and refuses a frontend framework and
 * the frontend-only options rather than dropping them.
 *
 * How it LOOKS is a `ThemeChoice` (see `theme-presets.ts`): a shadcn/ui base
 * color, an optional accent over it, a corner radius, and what switches the app
 * into its dark palette. `--theme` / `--radius` / `--dark` select it; nothing
 * about the look is prompted for, and with no flags it is plain shadcn/ui.
 *
 * `--marketplace <a,b>` installs marketplace add-ons into the new project and
 * registers them in `xano/index.ts`, so one command reproduces a project that
 * has them. See `init-modules.ts` for how a module declares the way it is
 * registered, and why the generated file can be as plain as it is.
 *
 * The agent brief, `AGENTS.md`, is written by default — it is the one file every
 * coding agent reads natively, so there is nothing to choose. `--no-agents-md`
 * skips it.
 *
 * `xano/` holds an empty-but-valid starter unless `--from <source>` fills it by
 * decoding an existing backend — a live workspace, a named ephemeral, or a
 * bundle already on disk. That is the same project either way;
 * only what is inside `xano/` differs, which is why it is a flag and not a
 * command of its own. This module resolves the flag; `codegen-command.ts` does
 * the pull.
 *
 * `--web` collects the same options in a browser instead of on the command
 * line. It never reaches this module: `cli.ts` dispatches it from the raw argv
 * before parsing, because it forwards its tail to a package it launches rather
 * than parsing it. See `init-web.ts`.
 *
 * The mechanics — the overwrite decision, writing the tree, the agent brief,
 * the optional install — live in `scaffold.ts`, shared with the `--from` path.
 * This module contributes the starter file set and the epilogue.
 *
 * Node-only; lazily imported from the CLI dispatcher so the browser-safe
 * authoring bundle never pulls it in.
 */
import { readEnvVar } from "../util/env.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { readVersion } from "./cli.js";
import type { CodegenSource } from "./codegen-command.js";
import { flagName, UsageError, unknownFlag } from "./errors.js";
import { shellQuote } from "../util/shell-quote.js";
import { displayPath } from "../util/rel-path.js";
import { flagNames } from "./commands.js";
import { parseSlot, requireBackendSlot } from "./backend-slot.js";
import { success, detail, blank, style, step, info, warn, error as fatal, quotedNames } from "./ui.js";
import { shellWord } from "./command-line.js";
import { isMachineOutput, writeJson } from "./output.js";
import {
  installModules,
  inProject,
  parseMarketplaceFlag,
  preflightPackages,
  rebaseLocalSpec,
  renderXanoIndexWithModules,
  type ModuleOutcome,
} from "./init-modules.js";
import { localPackageName, localPathOf, packageNameOf, readInstalledManifestState } from "./module-manifest.js";
import { isLocalSpecifier } from "./marketplace-resolve.js";
import { npmViewVersion } from "./npm.js";
import { ROUTES_MANIFEST_BASENAME } from "./routes-manifest.js";
import {
  changedOnDisk,
  describeClash,
  existingProjectClashes,
  isNonEmptyDir,
  MERGED_IN_EXISTING,
  scaffoldProject,
  XANO_DIR,
  type ScaffoldFile,
} from "./scaffold.js";
import {
  renderPackageJson,
  renderBackendPackageJson,
  renderBackendReadme,
  renderBackendTsconfig,
  BACKEND_TSCONFIG_PATH,
  renderTsconfig,
  renderLambdaTsconfig,
  renderViteConfig,
  renderIndexHtml,
  NODE_MIN,
  sdkDep,
  renderGitattributes,
  renderCheckWorkflow,
  checkJobDir,
  checkWorkflowName,
  checkWorkflowPath,
  renderGitignore,
  mergeGitignore,
  renderEnvExample,
  renderReadme,
  renderXanoIndex,
  renderXanoExampleMd,
  renderIndexCss,
  renderThemeModule,
  renderApiTs,
  renderCnUtil,
  initLanding,
  type GitattributesContribution,
  type ProjectInstall,
  type TemplateVars,
} from "./init-templates.js";
import { NO_FRONTEND, resolveFrameworkValue, resolveFrontendPreset } from "./frontend-resolve.js";
import {
  renderWorkspaceEnvExample,
  WORKSPACE_ENV_EXAMPLE_FILE,
} from "./workspace-env.js";
import { ensureWorkspaceEnvGitignored } from "./gitignore.js";
import { readToolchainBlock, readToolchainConfig } from "./project-config.js";
import type { Discovery } from "./toolchain-modules.js";
import { resolveThemeChoice } from "./theme-resolve.js";
import { composeBlock, gitattributesSpec, upsertBlock } from "./managed-blocks.js";
import { defaultThemeChoice, type ThemeChoice } from "./theme-presets.js";
import type { FrontendPreset, LandingContent } from "./frontend-presets.js";
import { detectInstallRoot, detectPackageManager, installCommandFor, userAgentVersion } from "./package-manager.js";
import { cliPrefixAt, projectFileCli, projectSdkDir, spellProjectCli, spellProjectSdkDir } from "./invocation.js";

/**
 * How the project at `dir` installs, for its CI workflow and README: the
 * manager, where it sits below the workspace root that installs it, and the
 * manager's version for a setup step that needs one (pnpm and bun, when no
 * `packageManager` field pins it).
 */
export function projectInstallOf(dir: string, env: NodeJS.ProcessEnv = process.env): ProjectInstall {
  const found = detectInstallRoot(dir, env);
  const { manager, root } = found;
  // An ancestor names the manager only when its workspace lists the project, so
  // a root other than the project is the workspace that installs it.
  const member = relative(root, resolve(dir)).split(sep).join("/");
  const needsVersion = !found.declared && (manager === "pnpm" || manager === "bun");
  const version = needsVersion ? (userAgentVersion(env.npm_config_user_agent, manager) ?? managerVersion(manager)) : undefined;
  return {
    manager,
    member,
    declared: found.declared,
    ...(version === undefined ? {} : { version }),
    ...(found.ignoreWorkspace ? { ignoreWorkspace: true } : {}),
    ...repoDirOf(root),
  };
}

/** `root`'s place below the enclosing git repository's top level, when it is not that top level. */
function repoDirOf(root: string): { repoDir?: string } {
  if (existsSync(join(root, ".git"))) return {};
  for (let d = dirname(root); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return { repoDir: relative(d, root).split(sep).join("/") };
    if (dirname(d) === d) return {};
  }
}

/**
 * The note for a check workflow written where GitHub never runs it: anywhere
 * but the repository's top level. Empty when the project is that top level.
 */
export function workflowPlacementNote(install: ProjectInstall | undefined, projectDir: string): string {
  const jobDir = checkJobDir(install);
  if (jobDir === "") return "";
  const file = checkWorkflowName(install);
  return (
    `GitHub runs workflows only from the repository root: move ${displayPath(join(projectDir, ".github", "workflows", file))} ` +
    `to ${displayPath(join(workflowRootDir(projectDir, jobDir), ".github", "workflows"))}/ (its steps already run in ${jobDir}).`
  );
}

/**
 * The file the placement note's move would replace, when one is already there —
 * this project's own workflow from an earlier `init`, moved up. Undefined when
 * the move lands on nothing, and at the top level, where nothing is moved.
 */
export function workflowMoveTarget(install: ProjectInstall | undefined, projectDir: string): string | undefined {
  const jobDir = checkJobDir(install);
  if (jobDir === "") return undefined;
  const target = join(workflowRootDir(projectDir, jobDir), ".github", "workflows", checkWorkflowName(install));
  return existsSync(target) ? displayPath(target) : undefined;
}

/**
 * After a scaffold: where its check workflow has to go, when it was written
 * somewhere GitHub never runs it — and a warning when the move would replace a
 * file already there.
 */
export function reportWorkflowPlacement(
  written: readonly string[],
  install: ProjectInstall | undefined,
  projectDir: string,
): void {
  if (!written.includes(checkWorkflowPath(install))) return;
  const placement = workflowPlacementNote(install, projectDir);
  if (placement !== "") info(placement);
  const taken = workflowMoveTarget(install, projectDir);
  if (taken !== undefined) {
    warn(`${taken} already exists — moving the new workflow there replaces it.`, "init.workflow-exists", [
      `Compare the two first, and keep whichever this project's CI should run.`,
    ]);
  }
}

/** The repository root above `projectDir`, which sits `jobDir` below it. */
function workflowRootDir(projectDir: string, jobDir: string): string {
  return resolve(projectDir, ...jobDir.split("/").map(() => ".."));
}

/** The template inputs for a project scaffolded at `dir`: how it installs, and the CLI prefix its files spell. */
export function templateVarsFor(appName: string, dir: string, env: NodeJS.ProcessEnv = process.env): TemplateVars {
  const install = projectInstallOf(dir, env);
  return {
    appName,
    sdkVersion: readVersion(),
    install,
    cli: projectFileCli(dir, install.manager),
    sdkDir: projectSdkDir(dir, install.manager),
  };
}

/** `<manager> --version`, or undefined when it cannot be run. */
function managerVersion(manager: string): string | undefined {
  const r = spawnSync(manager, ["--version"], { encoding: "utf8", timeout: 10_000, shell: process.platform === "win32" });
  const v = r.status === 0 ? r.stdout.trim() : "";
  return /^\d+\.\d+\.\d+/.test(v) ? v : undefined;
}

/** Letters with no decomposition to ASCII, by their usual transliteration. */
const TRANSLITERATED: Readonly<Record<string, string>> = {
  ł: "l", Ł: "L", ß: "ss", ẞ: "SS", æ: "ae", Æ: "AE", ø: "o", Ø: "O", đ: "d", Đ: "D", ð: "d", Ð: "D",
  þ: "th", Þ: "Th", œ: "oe", Œ: "OE", ħ: "h", Ħ: "H", ı: "i", ŀ: "l", Ŀ: "L", ŧ: "t", Ŧ: "T",
};

/**
 * Turn a raw name (a directory basename or `--name`) into a valid npm package
 * name: lowercase, non-alphanumerics collapsed to hyphens, edges trimmed.
 * Falls back to `app` when nothing usable survives.
 */
export function sanitizeAppName(raw: string): string {
  const name = raw
    // Decomposed and stripped of combining marks first, so `ünï` keeps its
    // letters (`uni`) instead of collapsing to a dash.
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    // Letters no decomposition reaches (`Ł`, `ß`, `æ`), by their usual spelling.
    .replace(/\P{ASCII}/gu, (c) => TRANSLITERATED[c] ?? c)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name === "" ? "app" : name;
}

/**
 * What installed toolchain modules contributed to the scaffolded files.
 *
 * Grouped BY PACKAGE, not flattened. The slots are additive and the SDK
 * composes them, but discarding attribution would make a scaffolded project
 * one-way. A module installed,
 * re-configured or removed AFTER `init` has to be reconciled in place, and that
 * needs the span each package owns to be findable, which needs its name and its
 * version at the moment the file is written. So whose line was whose decides
 * which marked block it lands in.
 *
 * `config` is keyed by package because `package.json` stores it that way.
 */
export interface ScaffoldContributions {
  /** One entry per contributing package; each becomes one marked block. */
  readonly gitattributes?: readonly GitattributesContribution[];
  /** Each module's config block, keyed by package name. */
  readonly xanosdk?: Readonly<Record<string, unknown>>;
}

/**
 * Put the modules' config blocks into the rendered manifest's `xanosdk` key,
 * over whatever the project already had there.
 *
 * `existing` is the block read off disk BEFORE this run wrote anything, and it
 * is what makes `init --force` in place survivable. The rendered manifest never
 * carries an `xanosdk` key of its own — `renderPackageJson` does not write one —
 * so folding only `xanosdk` in means a re-run publishes a block built purely
 * from the modules THIS run happened to load. Every other package's settings
 * vanish, and because absent config reads as enabled, an `enabled: false` that
 * deliberately turned a module off comes silently back on.
 *
 * Precedence is per package, not whole-block: `xanosdk` (newly computed from
 * this run's answers) wins for the packages it names, because it is the newer
 * statement of intent; every package it does not name keeps what the project
 * stored. Two writers for the key, reconciled by name rather than by order.
 */
function withXanoSdkBlock(
  rendered: string,
  xanosdk: Readonly<Record<string, unknown>> | undefined,
  existing: Readonly<Record<string, unknown>> | undefined,
): string {
  const merged = { ...existing, ...xanosdk };
  if (Object.keys(merged).length === 0) return rendered;
  const manifest = JSON.parse(rendered) as Record<string, unknown>;
  manifest["xanosdk"] = merged;
  try {
    return `${JSON.stringify(manifest, null, 2)}\n`;
  } catch (error) {
    // A module's config is its own data — a BigInt or a cycle in it must not
    // take the scaffold down after the install has already run.
    warn(
      "A module's configuration could not be serialized and was left out of package.json.",
      "init.module-config-dropped",
      [error instanceof Error ? error.message : String(error)],
    );
    return rendered;
  }
}

/**
 * The project shell every `init` writes — everything outside `xano/`. Shared so
 * the empty and pulled forms cannot drift on scripts, tsconfig, or the frontend
 * contract.
 *
 * `readme` and `landing` are supplied by the caller: a bare `init` addresses
 * someone about to author a backend, `--from` someone who just pulled one, and
 * the two want different copy. `preset` decides which framework renders that copy, and
 * `choice` decides what color it comes out.
 */
export function projectShellFiles(
  vars: TemplateVars,
  preset: FrontendPreset,
  parts: { readme: string; landing: LandingContent },
  choice: ThemeChoice = defaultThemeChoice(),
  contributions: ScaffoldContributions = {},
  // The project's stored `"xanosdk"` block, read before this run wrote anything.
  // Passed in rather than read here so this stays a pure renderer: the caller
  // knows when the on-disk manifest was still the user's, and a scaffold into
  // an empty directory has nothing to pass.
  existingXanoSdk?: Readonly<Record<string, unknown>>,
): ScaffoldFile[] {
  return spelledForProject(vars, [
    {
      path: "package.json",
      // The plugin config block rides in the rendered manifest rather than
      // being written after, so the scaffold has one file to reconcile instead
      // of a second pass patching the one it just wrote. What the project
      // already stored is folded in HERE rather than left to the scaffold's
      // merge, because that merge only runs on the two-pass (`--marketplace`)
      // path — a plain `init --force` writes this file once, and the block has
      // to survive that too.
      content: withXanoSdkBlock(
        renderPackageJson(vars, preset, choice),
        contributions.xanosdk,
        existingXanoSdk,
      ),
    },
    { path: "tsconfig.json", content: renderTsconfig(preset) },
    { path: "xano/lambdas/tsconfig.json", content: renderLambdaTsconfig() },
    { path: "vite.config.ts", content: renderViteConfig(preset) },
    { path: ".gitignore", content: renderGitignore(preset) },
    // The line-ending rule every generated artifact depends on. An installed
    // toolchain module adds its own display rules below it, each inside a
    // marked block keyed by the contributing package so a later reconcile can
    // find, replace, or remove exactly that module's lines.
    { path: ".gitattributes", content: renderGitattributes(contributions.gitattributes) },
    // The job that keeps derived state honest. A module contributes no steps to
    // it: its frozen check already rides on `npm run xano:check` through its
    // `onBundle` hook, so there is nothing for a CI slot to add.
    { path: checkWorkflowPath(vars.install), content: renderCheckWorkflow(vars.install) },
    { path: ".env.example", content: renderEnvExample() },
    { path: "README.md", content: parts.readme },
    // Skipped when the framework supplies its own entry document — see
    // FrontendPreset.ownsHtmlEntry. A second index.html beside SvelteKit's
    // app.html would never be served and would still read as the entry point.
    ...(preset.ownsHtmlEntry === true
      ? []
      : [{ path: "frontend/index.html", content: renderIndexHtml(vars, preset, choice) }]),
    // Shared across every framework: both UI kits resolve against the same
    // Tailwind v4 semantic tokens and look for library code at
    // frontend/src/lib/. Only the alias NAME pointing at that directory
    // differs, and the preset owns that — as it does where `cn()` comes from.
    { path: "frontend/src/index.css", content: renderIndexCss(choice) },
    { path: "frontend/src/lib/api.ts", content: renderApiTs() },
    { path: "frontend/src/lib/utils.ts", content: preset.libUtils ?? renderCnUtil(preset.libUtilsExtra) },
    // The mode store behind `--dark toggle`, shared by both presets' toggles —
    // it is plain DOM and localStorage, with nothing framework-shaped in it.
    // `system` and `off` need no state, so nothing is written for them.
    ...(choice.dark === "toggle"
      ? [{ path: "frontend/src/lib/theme.ts", content: renderThemeModule() }]
      : []),
    // The framework's own half: entry module, app component, vendored UI kit,
    // and whatever tool config that kit's CLI reads.
    ...preset.files(vars, parts.landing, choice),
  ]);
}

/**
 * Which project `init` writes into its target, decided before any file is
 * planned: `new` for an empty or missing directory, `existing` for anything
 * else. An existing project gets the backend only (see {@link backendShellFiles}).
 */
export type InitMode = "new" | "existing";

/** Where a project with no frontend sits: a new one owns its root, an existing one (at `dir`) keeps it. */
export type BackendShell =
  | { readonly kind: "new"; readonly readme: string }
  | { readonly kind: "existing"; readonly dir: string };

/**
 * The project shell for a project with no frontend — everything outside the
 * backend's own source.
 *
 * A NEW project owns its root, so it gets the manifest, the ignore and
 * attribute rules, the CI check and a README, as a full app does. An EXISTING
 * project keeps everything at its root: what the backend needs there is merged
 * in by the scaffold, never written over (see `scaffold.ts`). Either way
 * `xano/` type-checks under its own `xano/tsconfig.json`, so no root
 * `tsconfig.json` is written or read.
 */
export function backendShellFiles(
  vars: TemplateVars,
  shell: BackendShell,
  contributions: ScaffoldContributions = {},
  existingXanoSdk?: Readonly<Record<string, unknown>>,
): ScaffoldFile[] {
  const backend: ScaffoldFile[] = [
    { path: BACKEND_TSCONFIG_PATH, content: renderBackendTsconfig() },
    { path: "xano/lambdas/tsconfig.json", content: renderLambdaTsconfig("backend") },
  ];
  // Merged into an existing manifest by the scaffold (`mergePackageJson:
  // "project"`), which takes only what the backend needs from it. In an
  // existing project the `xanosdk` block carries only the modules this run
  // installed: the merge lays it over the stored block, so no other module's
  // settings can change. A new backend-only project has no stored block to
  // merge into, so it takes the whole of it.
  const manifest = {
    path: "package.json",
    content: withXanoSdkBlock(
      renderBackendPackageJson(vars),
      contributions.xanosdk,
      shell.kind === "existing" ? undefined : existingXanoSdk,
    ),
  };
  if (shell.kind === "existing") {
    return spelledForProject(vars, [
      manifest,
      ...backend,
      ...moduleTypeMarker(shell.dir),
      // The line-ending rule, scoped to `xano/`: a `*` rule at the project's
      // root would renormalize every file the project already has.
      { path: `${XANO_DIR}/.gitattributes`, content: renderGitattributes() },
      ...moduleGitattributes(shell.dir, contributions.gitattributes ?? []),
      ...gitignoreBlock(shell.dir, vars.sdkVersion),
    ]);
  }
  return spelledForProject(vars, [
    manifest,
    ...backend,
    { path: ".gitignore", content: renderGitignore() },
    { path: ".gitattributes", content: renderGitattributes(contributions.gitattributes) },
    { path: checkWorkflowPath(vars.install), content: renderCheckWorkflow(vars.install) },
    { path: "README.md", content: shell.readme },
  ]);
}

/**
 * `xano/package.json` holding only `"type": "module"`, for an existing project
 * whose own `package.json` is not `"type": "module"` — or nothing.
 *
 * The SDK is ESM-only, and a bare `.ts` file loads as CommonJS under a manifest
 * without that type (Next.js's, `npm init -y`'s). The project's manifest gains
 * no top-level key, so Node's per-folder rule carries the type instead: the
 * nearest `package.json` decides, and for `xano/` that is this one. Every walk
 * for the project root skips it (`holdsProjectManifest`), so the env, the lock
 * and the toolchain still resolve to the project. A project with no
 * `package.json` gets one that already says `"type": "module"`, and an
 * unparseable one is refused by the clash check, so neither gets it.
 */
function moduleTypeMarker(dir: string): ScaffoldFile[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return [];
  }
  if ((manifest as { type?: unknown } | null)?.type === "module") return [];
  return [{ path: `${XANO_DIR}/package.json`, content: `${JSON.stringify({ type: "module" }, null, 2)}\n` }];
}

/**
 * An existing project's `.gitignore` (or a new one) with the backend's ignore
 * rules spliced in as a managed block — or nothing, when it already says them.
 */
function gitignoreBlock(dir: string, version: string): ScaffoldFile[] {
  const path = join(dir, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  const merged = mergeGitignore(existing, version);
  return merged === existing ? [] : [{ path: ".gitignore", content: merged }];
}

/**
 * An existing project's root `.gitattributes` with each module's marked block
 * spliced in, the way a later `marketplace install` splices it — or nothing,
 * when no module contributes a rule.
 */
function moduleGitattributes(dir: string, contributions: readonly GitattributesContribution[]): ScaffoldFile[] {
  if (contributions.length === 0) return [];
  const path = join(dir, ".gitattributes");
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const { pkg, version, lines } of contributions) {
    const spec = gitattributesSpec(pkg);
    text = upsertBlock(text, spec, composeBlock(spec, lines, version)).text;
  }
  return [{ path: ".gitattributes", content: text }];
}

/** `files` with every `npx xanosdk` command spelled as the project's own files spell it ({@link TemplateVars.cli}). */
function spelledForProject(vars: TemplateVars, files: ScaffoldFile[]): ScaffoldFile[] {
  return files.map((f) => ({ ...f, content: spellProjectSdkDir(spellProjectCli(f.content, vars.cli), vars.sdkDir) }));
}

/** The `init` file set: the shell for this mode and frontend, plus the empty-but-valid starter backend. */
function buildFileSet(
  targetDir: string,
  vars: TemplateVars,
  preset: FrontendPreset | null,
  mode: InitMode,
  choice: ThemeChoice,
  contributions: ScaffoldContributions = {},
  existingXanoSdk?: Readonly<Record<string, unknown>>,
): ScaffoldFile[] {
  return [
    ...(preset === null
      ? backendShellFiles(
          vars,
          mode === "new" ? { kind: "new", readme: renderBackendReadme(vars) } : { kind: "existing", dir: targetDir },
          contributions,
          existingXanoSdk,
        )
      : projectShellFiles(
          vars,
          preset,
          { readme: renderReadme(vars, preset, choice), landing: initLanding(vars) },
          choice,
          contributions,
          existingXanoSdk,
        )),
    ...spelledForProject(vars, [
      { path: "xano/index.ts", content: renderXanoIndex(vars) },
      { path: "xano/EXAMPLE.md", content: renderXanoExampleMd(vars) },
    ]),
    // The BACKEND counterpart of `.env.example`, one directory down: the same
    // pair, for the half of the project the engine runs. `xano/.env` itself is
    // never written by a scaffold — only by the user, or by `xanosdk env pull`.
    //
    // Here rather than in `projectShellFiles`, which the PULL path also uses:
    // `placeGeneratedFiles` emits this file with the names the source declares,
    // and two entries for one path left the right one winning on array order
    // alone. A bare `init` has no names, so it writes the empty template.
    { path: WORKSPACE_ENV_EXAMPLE_FILE, content: renderWorkspaceEnvExample([]) },
  ];
}

/**
 * `--from <source>` as a resolved {@link CodegenSource}.
 *
 * A backend is spelled the way it is spelled on every other command, because
 * the value is parsed against `init --from`'s declared slot in the registry:
 * `--from ephemeral:pr-3` and `test --on ephemeral:pr-3` cannot come to mean
 * different things, and help, completion and this refusal list the same kinds.
 * The one spelling `--from` has beyond a running backend or a release is a path
 * to a bundle already on disk, unambiguous against the keywords (a bundle is a
 * `.json` file, or something written with a directory in front of it).
 *
 * A near-miss on a keyword (`--from Workspace`) is refused rather than read as
 * a path, since "no bundle file at ./Workspace" names neither the mistake nor
 * the fix.
 */
export function resolveFromSource(raw: string): CodegenSource {
  return parseSlot(requireBackendSlot("init", undefined, "from"), raw);
}

/**
 * Flags that only mean something once `xano/` is being decoded from somewhere.
 *
 * Rejected rather than ignored: `--skip-roundtrip` on a bare `init` reads as
 * "skip the check", and silently accepting it would teach that a check was
 * skipped when there was never one to run.
 */
function rejectPullOnlyFlags(args: ParsedArgs): void {
  const passed = [
    ...(args.report !== undefined ? ["--report"] : []),
    ...(args.skipRoundtrip ? ["--skip-roundtrip"] : []),
    // Tokens are found by decoding a source; a plain init decodes nothing.
    ...(args.noSecrets ? ["--no-secrets"] : []),
    // Confirms replacing a decoded `xano/` (`--from`), or the files an
    // `init --force` over an existing project overwrites.
    ...(args.yes && !args.force ? ["--yes"] : []),
    ...(args.branch !== undefined ? ["--branch"] : []),
    // A plain init signs in to nothing, so an OAuth host has nowhere to go.
    ...(args.authHost !== undefined ? ["--origin"] : []),
  ];
  if (passed.length === 0) return;
  if (passed.length === 1 && passed[0] === "--yes") {
    throw new UsageError(
      "`--yes` confirms what `--from` or `--force` replaces, so it does nothing without one of them. " +
        "Add `--force` to scaffold over an existing project, or drop the flag.",
      { helpFor: { command: "init" } },
    );
  }
  throw new UsageError(
    `${passed.join(" and ")} ${passed.length === 1 ? "describes" : "describe"} the pull that ` +
      `\`--from\` performs, so ${passed.length === 1 ? "it does" : "they do"} nothing without it. ` +
      `Add \`--from <source>\`, or drop ${passed.length === 1 ? "the flag" : "them"}.`,
    { helpFor: { command: "init" } },
  );
}

/** The options that only mean something to a frontend, as typed — those that were passed. */
function frontendOnlyFlags(args: ParsedArgs): string[] {
  return [
    ...(args.theme !== undefined ? ["--theme"] : []),
    ...(args.radius !== undefined ? ["--radius"] : []),
    ...(args.dark !== undefined ? ["--dark"] : []),
    ...(args.font !== undefined ? ["--font"] : []),
    ...(args.fontMono !== undefined ? ["--font-mono"] : []),
    ...(args.fontHeading !== undefined ? ["--font-heading"] : []),
    ...(args.icons !== undefined ? ["--icons"] : []),
  ];
}

/**
 * Refuse the frontend-only options when no frontend is being written, rather
 * than dropping them: a `--theme` that silently did nothing reads as applied.
 * `why` says why there is no frontend.
 */
export function refuseFrontendOnlyFlags(args: ParsedArgs, why: string): void {
  const passed = frontendOnlyFlags(args);
  if (passed.length === 0) return;
  const one = passed.length === 1;
  throw new UsageError(
    `${passed.join(", ")} ${one ? "applies" : "apply"} only with a frontend, and ${why}. Drop ${one ? "it" : "them"}.`,
    { helpFor: { command: "init" } },
  );
}

/**
 * The frontend `init` writes, as far as the flags decide it before anything is
 * written: a preset, `null` for none, or `undefined` while a new project's
 * framework is still to be asked (a terminal, and no `--framework`).
 *
 * An existing project gets no frontend and no prompt: it has its own app, so a
 * framework that names one is refused rather than written beside it. The
 * frontend-only options are refused wherever no frontend is written.
 */
export async function resolveInitFrontend(
  args: ParsedArgs,
  targetDir: string,
  mode: InitMode,
): Promise<FrontendPreset | null | undefined> {
  if (mode === "existing") {
    if (args.framework !== undefined && resolveFrameworkValue(args.framework) !== null) {
      throw new UsageError(
        `\`--framework ${args.framework}\` writes a new frontend, and ${targetDir} is not empty: an existing app gets ` +
          `the backend only. Drop --framework to add the backend to it, or run init in an empty directory for a full app.`,
        { helpFor: { command: "init" } },
      );
    }
    refuseFrontendOnlyFlags(args, `${targetDir} is an existing project, which gets the backend only`);
    return null;
  }
  if (args.framework === undefined) return undefined;
  const preset = resolveFrameworkValue(args.framework);
  if (preset === null) refuseFrontendOnlyFlags(args, `\`--framework ${NO_FRONTEND}\` writes none`);
  return preset;
}

/** How many entries an existing `xano/xano.lock` carries, or undefined when there is none. */
function readLockEntryCount(targetDir: string): number | undefined {
  const path = join(targetDir, LOCK_REL);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { objects?: unknown };
    return parsed.objects !== null && typeof parsed.objects === "object" ? Object.keys(parsed.objects).length : 0;
  } catch {
    return 0;
  }
}

/**
 * Adding the backend to an existing project: refuse what it would write over,
 * listing every clash, or — under `--force` — name what it overwrites and
 * confirm, the way a re-run of `init --from` does. Nothing has been written
 * when this runs, so a refusal or a "no" leaves the project as it was.
 *
 * Returns the clashing scripts `--force` takes over, or "cancelled".
 */
export async function settleClashes(
  targetDir: string,
  files: readonly ScaffoldFile[],
  args: ParsedArgs,
): Promise<readonly string[] | "cancelled"> {
  const clashes = existingProjectClashes(targetDir, files);
  if (clashes.length === 0) return [];
  const one = clashes.length === 1;
  if (!args.force) {
    // Off a terminal, `--force` alone then stops at the overwrite confirmation
    // naming `--yes`: two refusals for one fix. Both flags, at once.
    throw new UsageError(
      `init adds the backend to ${targetDir}, and ${one ? "this clashes" : `these ${clashes.length} clash`} with what ` +
        `is already there:\n${clashes.map((c) => `  ${describeClash(c)}`).join("\n")}\nNothing was written. ` +
        (process.stdin.isTTY === true
          ? `Re-run with --force to write over ${one ? "it" : "them"}.`
          : `Re-run with --force --yes to write over ${one ? "it" : "them"} (--yes confirms the overwrite, which ` +
            `cannot be asked without a terminal).`),
    );
  }
  const scripts = clashes.flatMap((c) => (c.kind === "script" ? [c.name] : []));
  // What actually changes: a clashing file rewritten to the bytes it already
  // holds is not an overwrite worth asking about.
  const changed = changedOnDisk(targetDir, files.filter((f) => !MERGED_IN_EXISTING.has(f.path)));
  const listed = [...changed, ...clashes.filter((c) => c.kind === "script").map(describeClash)];
  if (listed.length === 0) return scripts;
  const counted = [
    ...(changed.length === 0 ? [] : [`${changed.length} file${changed.length === 1 ? "" : "s"}`]),
    ...(scripts.length === 0 ? [] : [`${scripts.length} script${scripts.length === 1 ? "" : "s"}`]),
  ].join(" and ");
  // The entries are the warning's remedy lines, so its `--json` entry names
  // them rather than ending on a colon (E2E pass 28).
  warn(`init --force overwrites ${counted} already in ${targetDir}:`, "init.overwrite", [
    ...listed.slice(0, 30),
    ...(listed.length > 30 ? [`… and ${listed.length - 30} more`] : []),
  ]);
  if (args.yes === true) return scripts;
  const { confirm } = await import("./prompt.js");
  // The question names what it asks about: off a terminal it is the refusal's
  // whole message, where "Overwrite them?" had no referent. The refusal
  // carries every entry as `details.files`.
  const { yesRerun } = await import("./retry-command.js");
  const { rerun, note } = yesRerun(args, "init");
  const noun = scripts.length === 0 ? "file" : changed.length === 0 ? "script" : "file and script";
  const ok = await confirm(
    `Overwrite ${listed.length === 1 ? `this ${noun}` : `these ${listed.length} ${noun === "file and script" ? "files and scripts" : `${noun}s`}`} in ${targetDir}?`,
    { flag: "--yes", refusal: { details: { written: false, files: listed }, rerun, note } },
  );
  if (!ok) {
    info("Cancelled. Nothing was written.");
    return "cancelled";
  }
  return scripts;
}

/**
 * The least `package.json` `npm install` will accept, written before the
 * modules install so it has a directory to install into.
 *
 * Deliberately not the rendered manifest: that one depends on questionnaire
 * answers this pass has not collected yet. Everything here survives into the
 * full manifest through `mergePackageJson`, and every value is one the second
 * pass restates anyway, so a run that fails between the two leaves a manifest
 * that is thin rather than wrong.
 */
function renderMinimalPackageJson(appName: string, sdkVersion: string): string {
  return `${JSON.stringify(
    {
      name: appName,
      // yarn 1 ignores a workspace member with no version and then fails the
      // add; the scaffold's own manifest carries the same one.
      version: "0.1.0",
      private: true,
      type: "module",
      // `sdkDep`, not `^version`: the scaffold's range is written out as
      // `>=<version> <next major`, the same shape a module's peer range has, so
      // every manifest this CLI writes or restores reads alike.
      dependencies: { "@xano/sdk": sdkDep(sdkVersion) },
      engines: { node: `>=${NODE_MIN}` },
    },
    null,
    2,
  )}\n`;
}

/**
 * The scaffold was written and one of its add-ons, or the project's own `npm install`, was not.
 *
 * Same shape as `codegen`'s verify code and `preflight`'s: the command ran, and
 * something it was asked to produce is missing. Distinct from a thrown failure,
 * where nothing usable exists at all.
 */
const EXIT_MODULE_INSTALL_FAILED = 2;

/** What the target held before pass one wrote into it. */
interface RollbackSnapshot {
  readonly dir: string;
  /** Top-level entries, or undefined when the directory did not exist. */
  readonly entries: ReadonlySet<string> | undefined;
  /** The manifests pass one and `npm install` rewrite in place, as they were. */
  readonly saved: ReadonlyMap<string, string>;
}

const PASS_ONE_REWRITES = ["package.json", "package-lock.json"] as const;

function snapshotForRollback(dir: string): RollbackSnapshot {
  if (!existsSync(dir)) return { dir, entries: undefined, saved: new Map() };
  const saved = new Map<string, string>();
  for (const name of PASS_ONE_REWRITES) {
    const path = join(dir, name);
    if (existsSync(path)) saved.set(name, readFileSync(path, "utf8"));
  }
  return { dir, entries: new Set(readdirSync(dir)), saved };
}

/**
 * Undo pass one after a refusal the questionnaire made, and say so on the
 * refusal itself: removes the target when this run created it, otherwise every
 * top-level entry it added, and restores the manifests it rewrote. A
 * `node_modules` that was already there is left as npm left it — named, since
 * it is the one thing that could not be put back.
 */
function rollBackPassOne(snap: RollbackSnapshot, err: unknown): void {
  let note: string;
  try {
    if (snap.entries === undefined) {
      rmSync(snap.dir, { recursive: true, force: true });
      note = `Nothing was left behind: ${snap.dir} was created by this run and has been removed.`;
    } else {
      for (const entry of readdirSync(snap.dir)) {
        if (!snap.entries.has(entry)) rmSync(join(snap.dir, entry), { recursive: true, force: true });
      }
      for (const [name, text] of snap.saved) writeFileSync(join(snap.dir, name), text, "utf8");
      note = snap.entries.has("node_modules")
        ? `What this run wrote into ${snap.dir} was undone, except node_modules, which already existed.`
        : `Nothing was left behind: what this run wrote into ${snap.dir} has been removed.`;
    }
  } catch (cleanup) {
    note = `Cleaning up ${snap.dir} failed (${cleanup instanceof Error ? cleanup.message : String(cleanup)}); remove it before re-running.`;
  }
  if (err instanceof Error) err.message = `${err.message} ${note}`;
}

export async function runInitCommand(args: ParsedArgs): Promise<void> {
  if (args.from !== undefined) {
    // `init` declares `deferUnknownFlags`, so the parser handed its unknowns
    // through instead of refusing them — and this branch returns before the
    // questionnaire that would claim them. Refusing here is the other half of
    // that obligation: without it `init --from workspace --frozen-lok` is
    // silently accepted — an accepted-and-discarded flag slipping back in
    // through the door built to close it. `--from` loads no plugins, so nothing
    // can claim any of them.
    if (args.unknownFlags.length > 0) {
      throw unknownFlag(args.unknownFlags, { command: "init" });
    }
    // `--marketplace` is a modelled flag, so the refusal above does not catch
    // it — and this branch never reaches `installModules`, so the add-ons were
    // silently dropped: a project missing what the command line named, which
    // is the one thing the rest of this file now exits non-zero over. Refused
    // rather than supported, because a `--from` run writes a project around a
    // workspace that ALREADY exists, and adding add-ons to one of those is
    // `marketplace install`.
    if (args.marketplace.length > 0) {
      throw new UsageError(
        "`--from` and `--marketplace` do not compose: `--from` writes a project around a backend that already exists. " +
          "Scaffold it first, then add each package with `xanosdk marketplace install <package>`.",
        { helpFor: { command: "init" } },
      );
    }
    const source = resolveFromSource(args.from);
    // Only a bundle on disk: a hosted source resolves `--profile` to read it,
    // and refuses an unknown one there, and a Xano Engine refuses the flag.
    if (source.kind === "file") await refuseUnknownProfileFlag(args, resolve(args.positionals[0] ?? "."));
    const { runInitFromCommand } = await import("./codegen-command.js");
    return runInitFromCommand(args, source);
  }
  rejectPullOnlyFlags(args);
  const targetArg = args.positionals[0] ?? ".";
  const targetDir = resolve(targetArg);
  // Before pass one writes a manifest: a refusal must leave nothing behind for
  // the corrected re-run to be refused over.
  await refuseUnknownProfileFlag(args, targetDir);
  const appName = sanitizeAppName(args.name ?? basename(targetDir));
  // Judged before anything is written: an empty or missing directory is a new
  // project; anything else is an existing one, which gets the backend only.
  const mode: InitMode = isNonEmptyDir(targetDir) ? "existing" : "new";

  // Read BEFORE pass one, which overwrites `package.json` with a minimal
  // manifest so npm has somewhere to install into — and would therefore destroy
  // the very block this is here to preserve. `init --force` into a project that
  // already configures toolchain modules must not silently drop their settings:
  // a deleted `enabled: false` reads as enabled, so the module the user turned
  // off comes back on. Empty for a scaffold into an empty directory.
  const existingXanoSdk = readToolchainBlock(targetDir);

  /*
   * ── Pass one: a minimal manifest, then the install ────────────────────────
   *
   * Two passes, and the reason is npm. `installModules` shells out to
   * `npm install` INSIDE the target directory, which needs a `package.json` to
   * already exist there — and the scaffold writes that file as part of the full
   * file set, which is why install has always had to run last.
   *
   * But a toolchain module's questions have to reach the questionnaire, and the
   * module is not on disk to ask until it is installed. Moving install earlier
   * without splitting the write means npm either runs against a directory with
   * no manifest, or has the dependency entry it just wrote overwritten by
   * `renderPackageJson`.
   *
   * So: write the minimum npm needs, install, read the plugins' questions, ask
   * everything, then write the rest — merging the `dependencies` and `xanosdk`
   * blocks rather than overwriting them (see `mergePackageJson` in scaffold.ts).
   */
  const typedModules = parseMarketplaceFlag(args.marketplace);
  // `--no-install` means no npm install, for the add-ons as much as for the
  // scaffold's own dependencies: they are recorded in package.json and left for
  // the `npm install` the next steps name. Nothing is on disk to read a
  // registration from, so none is wired into xano/index.ts either — the summary
  // says how. Pass one (the minimal manifest and the install) is skipped
  // outright, which is what kept `--no-install` from being honoured.
  // Decided HERE, but ONLY when pass one is going to write. Pass one writes a
  // manifest and runs `npm install` into the target, so leaving the decision to
  // `scaffoldProject` would have it judge a directory this very command had
  // just populated — and refuse a scaffold into what was an empty directory a
  // moment earlier.
  //
  // Without modules nothing is written until the scaffold, so the decision
  // stays where it was. That ordering matters beyond tidiness: a usage error
  // must beat an environment one. Deciding unconditionally here would answer
  // `xanosdk init --typo` with "target directory is not empty", sending the
  // reader to fix something that was never why the run stopped. Every
  // flag-answerable choice is validated BEFORE pass one writes a manifest and
  // shells out to `npm install`. Otherwise a mistyped `--framework` would cost
  // an install and then fail, leaving a directory holding a minimal
  // package.json and node_modules — which `decideOverwrite` then reads as
  // non-empty, so the corrected re-run would be refused. A usage error should
  // cost nothing and leave nothing. (These resolve from flags without prompting
  // when a flag is given; the interactive path still happens below, after the
  // install.)
  const flagFrontend = await resolveInitFrontend(args, targetDir, mode);
  if (flagFrontend !== null) await resolveThemeChoice(args);
  // The unknown flags no module could claim, refused before anything is
  // installed. The catalogue carries no question flags, so a flag a module MAY
  // derive (`--frob`) can only be refused once the questionnaire has asked the
  // installed modules (E2E pass 25) — but a module may derive only a long flag,
  // and never one the CLI owns (`--to`, `--env-var`: see `assertNoFlagCollisions`),
  // so those are refused now, at no install's cost.
  const unclaimable = args.unknownFlags.filter((f) => {
    const name = flagName(f);
    if (!name.startsWith("--")) return true;
    const bare = name.slice(2);
    return flagNames().includes(bare) || (bare.startsWith("no-") && flagNames().includes(bare.slice(3)));
  });
  if (unclaimable.length > 0) throw unknownFlag(unclaimable, { command: "init" });
  // A Yarn Plug'n'Play workspace links no node_modules, which the project's
  // build and every module read: refused before anything is written.
  const { refusePlugAndPlay } = await import("./project-dependency.js");
  const { retryCommand } = await import("./retry-command.js");
  refusePlugAndPlay(targetDir, retryCommand(args, { command: "init" }).command);
  // `--marketplace` joins them, answered without writing a byte. Each name is
  // resolved through the catalogue first — the resolver `marketplace install`
  // uses, so `--marketplace auth` means `@xano-sdk/auth` and never npm's
  // unrelated `auth`, and a name the catalogue does not list is refused (exit
  // 8). Then the registry is asked about the resolved names (see
  // `preflightPackages`): only a 404 stops the run there; every other npm
  // failure is left to the install below, which says what npm said.
  const { resolveMarketplaceSpecs, withCatalogueRerun } = await import("./marketplace-resolve.js");
  const resolvedModules =
    typedModules.length === 0
      ? []
      : await resolveMarketplaceSpecs(typedModules, "xanosdk init --marketplace").catch(async (err: unknown) => {
          throw await withCatalogueRerun(err, args, "init");
        });
  // A path is typed relative to here, and every install runs inside the target.
  const requestedModules = resolvedModules.map((spec) => rebaseLocalSpec(spec, process.cwd(), targetDir));
  if (args.noInstall) for (const spec of requestedModules) deferredDependency(spec, targetDir);
  if (requestedModules.length > 0) preflightPackages(requestedModules, targetDir);
  const deferredModules = args.noInstall ? requestedModules : [];
  const modules = args.noInstall ? [] : requestedModules;

  let moduleOutcome: ModuleOutcome | undefined;
  // Judged before pass one writes anything into the target: whether a lock is
  // already there.
  const hadLock = readLockEntryCount(targetDir);
  // An existing project's clashes, settled before the first write: the scripts
  // `--force` takes over, or undefined until settled.
  let overrideScripts: readonly string[] | undefined;
  /** The backend's files as clash-checked; the modules' contributions only merge, so they never add a clash. */
  const settle = async (): Promise<readonly string[] | "cancelled"> =>
    mode === "existing"
      ? settleClashes(
          targetDir,
          buildFileSet(targetDir, { appName, sdkVersion: readVersion() }, null, mode, defaultThemeChoice(), {}, existingXanoSdk),
          args,
        )
      : [];
  // What the target held before pass one wrote into it, so a refusal that only
  // the questionnaire can make (a flag no installed module claims) can undo it.
  let passOne: RollbackSnapshot | undefined;
  if (modules.length > 0) {
    const settled = await settle();
    if (settled === "cancelled") return;
    overrideScripts = settled;
    passOne = snapshotForRollback(targetDir);
    mkdirSync(targetDir, { recursive: true });
    // An existing project's manifest is the project's: the modules' install
    // adds to it, and nothing here writes over it.
    if (mode === "new" || !existsSync(join(targetDir, "package.json"))) {
      writeFileSync(
        join(targetDir, "package.json"),
        renderMinimalPackageJson(appName, readVersion()),
        "utf8",
      );
    }
    blank();
    moduleOutcome = await installModules(targetDir, modules);
    // A toolchain module's other peers, as `marketplace install` adds them (one
    // helper, so the two commands leave the same dependencies). Here, in pass
    // one, because the scaffold's package.json merges what pass one recorded and
    // its install then puts it on disk. Never under `--no-install`: `modules` is
    // empty there, and nothing was installed to read peers from.
    if (moduleOutcome.toolchain.length > 0) {
      const { addToolchainPeers } = await import("./toolchain-peers.js");
      const rerun = retryCommand(args, { command: "init" }).command;
      for (const pkg of moduleOutcome.toolchain) await addToolchainPeers(targetDir, pkg, rerun);
    }
  }

  // Pass one wrote a manifest and ran `npm install` before the questionnaire
  // can refuse a flag no installed module claims (`--marketplace auth --frob`)
  // or an answer a module rejects. The catalogue carries no question flags, so
  // that refusal cannot come earlier — but it must still cost nothing: a
  // leftover package.json makes the corrected re-run "not empty". Everything
  // up to the scaffold write is undone on a throw; after it, the project is real.
  let scaffolded = false;
  try {
    // Imported now, before any questionnaire and before the entry file of a
    // scaffolded project could ever be loaded. Non-frozen: `init` is a write.
    const { discoverToolchainPlugins } = await import("./toolchain-modules.js");
    // `configuring: true`: the questionnaire below IS the configuration step, so
    // discovery must not warn about a module this run is about to ask about.
    const toolchain = await discoverToolchainPlugins(targetDir, { frozen: false, configuring: true });

    // The framework is resolved first: it is the structural choice (it decides
    // what the project *is*), and its answer feeds the prose `AGENTS.md` renders.
    const preset = flagFrontend !== undefined ? flagFrontend : await resolveFrontendPreset(args.framework);
    // "No frontend" chosen at the prompt: the options a frontend would have
    // used are refused here, as `--framework none` refuses them up front.
    if (preset === null && flagFrontend === undefined) refuseFrontendOnlyFlags(args, "no frontend was chosen");
    // Theme never prompts — it is flags only, so it does not sit in the
    // questionnaire at all and resolving it here costs no round trip.
    const choice = await resolveThemeChoice(args);

    // Plugin questions come LAST in the questionnaire: the SDK's own choices are
    // structural, and a module's are about the module.
    //
    // The SHARED step, not a second copy of it. `init` and the reconciler put the
    // same questions to the same modules and must reach the same state from the
    // same answers, so the collision check, the read-back of stored answers, the
    // resolution and the report of every dropped key live in one place. `init`
    // scaffolds into a directory that is normally empty, so there is rarely
    // anything stored — but `init --force` in place is a real posture, and
    // reading the project's own answers back there is what keeps a re-run from
    // resetting a setting the user chose.
    const { pluginPrompter } = await import("./plugin-prompt.js");
    const { contributionOutcomes, recordedConfig, runPluginQuestionnaire } = await import(
      "./plugin-contributions.js"
    );
    const { answers: pluginAnswers } = await runPluginQuestionnaire(toolchain.loaded, {
      host: "init",
      unknownFlags: args.unknownFlags,
      // `init --json` answers with one document, so a question prompted under it
      // would interleave with a stdout a script is about to parse.
      prompter: pluginPrompter({ json: args.json }),
    });

    // What each module contributes, from its own answers. Guarded and refused in
    // one shared place — see `plugin-contributions.ts` — so `init` cannot accept
    // a module shape a later `marketplace install` would refuse.
    //
    // OUTCOMES, not the flat contributed-only view: a module that declines its
    // enabling question contributes nothing, and what the project records for it
    // is precisely what `recordedConfig` decides below. Reading only the
    // contributed entries would record nothing for a declined module — which
    // reads back as ENABLED and re-renders what the user just said no to.
    const outcomes = contributionOutcomes(toolchain.loaded, pluginAnswers, "init");
    // Kept per package rather than concatenated. Each module's lines become one
    // marked block naming it and stamped with its version, which is what makes a
    // scaffolded project re-appliable: a later install, re-configure or remove
    // rewrites exactly that span and nothing around it. A module contributing
    // only `config` has no lines and so gets no block.
    const gitattributes = outcomes.flatMap((o) => {
      const lines = o.parts?.gitattributes ?? [];
      return lines.length === 0 ? [] : [{ pkg: o.pkg, version: o.version, lines }];
    });
    // The SHARED rule, not a second reading of it — see `recordedConfig`. `init`
    // and the reconciler have to reach the same configured state from the same
    // answers, and the four arms of that decision are the part they disagreed
    // about. `undefined` means "leave what is stored", which `withXanoSdkBlock`
    // delivers by merging this OVER the project's existing block.
    const pluginConfig: Record<string, unknown> = {};
    for (const outcome of outcomes) {
      const record = recordedConfig(outcome, existingXanoSdk?.[outcome.pkg]);
      if (record !== undefined) pluginConfig[outcome.pkg] = record;
    }

    const vars = templateVarsFor(appName, targetDir);

    // Without add-ons nothing has been written yet, so an existing project's
    // clashes are judged here — after every usage error has had its turn, and
    // before the line below announces a scaffold they are about to refuse.
    if (overrideScripts === undefined) {
      const settled = await settle();
      if (settled === "cancelled") return;
      overrideScripts = settled;
    }
    const fileSet = buildFileSet(targetDir, vars, preset, mode, choice, { gitattributes, xanosdk: pluginConfig }, existingXanoSdk);

    step(
      mode === "existing"
        ? `Adding a Xano backend to ${style.bold(appName)} in ${targetDir}`
        : preset === null
          ? `Scaffolding ${style.bold(appName)} (no frontend) in ${targetDir}`
          : `Scaffolding ${style.bold(appName)} (${preset.label}, ${choice.theme.label}) in ${targetDir}`,
    );

    // Decided before the write, so the pointer is among the files listed.
    const pin = await planProfilePin(args, targetDir);
    scaffolded = true;
    const result = await scaffoldProject({
      targetDir,
      files: [...fileSet, ...(pin.file === null ? [] : [pin.file])],
      agentsMd: !args.noAgentsMd,
      appName,
      force: args.force,
      noInstall: args.noInstall,
      // An `init` project's `xano/` is hand-authored, never machine-written: it is
      // not refreshable, and `--force` must not clear it.
      regenerable: false,
      // A new project's directory is empty, and an existing one's clashes were
      // settled above: nothing here is refused.
      overwrite: "full",
      // An existing project's manifest is the user's, merged into with the
      // project winning. Otherwise only the module path writes package.json
      // twice, so only that path merges.
      mergePackageJson: mode === "existing" ? "project" : modules.length > 0 ? "rendered" : undefined,
      overrideScripts,
      // A project install failing for the reason an add-on's already did (the
      // manifest they share names a range npm has no version for) is that one
      // failure, already warned — not a second warning repeating npm's text.
      reportedNpmFailures: moduleOutcome?.reported,
      sdkVersion: readVersion(),
      frontend: preset,
      theme: choice,
    });

    // The scaffolded `.gitignore` carries a bare `.env`, which matches at any
    // depth and already covers this — but `init` into an existing repo keeps that
    // repo's ignore rules, and a root-anchored `/.env` does not.
    ensureWorkspaceEnvGitignored(targetDir);
    if (vars.install?.ignoreWorkspace === true) {
      // pnpm installs the nearest workspace root from anywhere below it, so a
      // plain `pnpm install` here would skip this project's own dependencies.
      info(
        `${targetDir} is below a pnpm workspace that does not list it, so it installs on its own: ` +
          `\`${installCommandFor(targetDir)}\`. To make it a member instead, add its path to that workspace's pnpm-workspace.yaml.`,
      );
    }

    reportWorkflowPlacement(result.written, vars.install, targetDir);

    pin.report();
    const pinnedProfile = pin.name;

    if (preset !== null) info(`Theme: ${choice.theme.label} — dark mode: ${choice.dark}`);

    if (deferredModules.length > 0) {
      recordDeferredModules(targetDir, deferredModules);
      info(`Added to package.json, not installed (--no-install): ${deferredModules.join(", ")}.`);
      // By package name: a path is not a catalogue entry, and an unlisted local
      // module's wiring is in its own README.
      const listed = deferredModules.filter((m) => !isLocalSpecifier(m)).map(packageNameOf);
      const local = deferredModules.flatMap((m) => {
        const name = localPackageName(m, targetDir);
        return name === undefined ? [] : [`${name} (${localPathOf(m)})`];
      });
      detail(
        `Run \`${inProject(targetDir)}${installCommandFor(targetDir)}\`, then register ${deferredModules.length === 1 ? "it" : "each"} in xano/index.ts` +
          (listed.length === 0
            ? ""
            : ` — ${listed.map((m) => `\`xanosdk marketplace details ${shellQuote(m)}\``).join(", ")} print${listed.length === 1 ? "s" : ""} the wiring`) +
          (local.length === 0 ? "" : `${listed.length === 0 ? " —" : ";"} ${local.join(", ")}: see ${local.length === 1 ? "its" : "each one's"} README`) +
          `.`,
      );
    }

    /*
     * Add-ons come after the scaffold, and they have to.
     *
     * A module's registration is read from the package itself, so the package
     * has to be on disk before anything can be written about it — which means
     * `xano/index.ts` is written twice for a project with add-ons: once by the
     * file set above, as the empty starter, and again here once we know what
     * there is to register. Writing it once at the end instead would mean a
     * failed install leaves no backend file at all.
     */
    /** Project files derived from the entry after add-ons were wired (see writeDerivedFiles). */
    let derived: string[] = [];
    let entryFailed = false;
    let addonEnv: readonly string[] = [];
    if (moduleOutcome !== undefined) {
      const outcome = moduleOutcome;
      // Rewritten when anything installed, registered or not. A module that could
      // not be wired still belongs in this file as a commented line saying so —
      // see `renderXanoIndexWithModules`.
      if (outcome.installed.length > 0) {
        writeFileSync(
          join(targetDir, "xano", "index.ts"),
          spellProjectCli(renderXanoIndexWithModules(appName, outcome.registered, outcome.unwired), vars.cli),
          "utf8",
        );
      }
      if (outcome.toolchain.length > 0) {
        // Not "unwired": a toolchain module extends the CLI and registers
        // nothing, so there is no missing step for the reader to go and do.
        info(
          `Extends the CLI (nothing to register): ${outcome.toolchain.join(", ")}. ` +
            `Configured in this project's package.json "xanosdk" block.`,
        );
      }
      if (outcome.registered.length > 0) {
        info(`Registered in xano/index.ts: ${outcome.registered.map((m) => m.pkg).join(", ")}`);
        // A registered add-on can bring the project's first endpoints, and the
        // scaffold's `xano:check` fails on a route manifest or a lock the project
        // does not have yet. Written here, from the project as it now stands, so
        // the first CI run is green without a manual step. Only after a real
        // install: the entry cannot be loaded without its dependencies.
        if (result.install === "installed" && sdkResolves(targetDir)) {
          const derivation = await writeDerivedFiles(
            targetDir,
            (env) => spellProjectCli(renderXanoIndexWithModules(appName, outcome.registered, outcome.unwired, env), vars.cli),
            toolchain,
          );
          derived = derivation.written;
          entryFailed = derivation.failed === true;
          addonEnv = derivation.env;
        }
      }
      for (const module of outcome.unwired) {
        // Installed but not wired. Said per module with the reason, because the
        // fix differs: a package with no `xanosdk` field needs one, a package that
        // failed to load needs looking at.
        warn(
          `${module.pkg} is installed but not registered — ${runFromHere(module.reason, targetDir)}.`,
          "module.unregistered",
          [`Import it in xano/index.ts and register it onto the workspace yourself.`],
        );
      }
      if (outcome.failed.length > 0) {
        /*
         * Exited non-zero, and named again in the run's ending line below.
         *
         * A run that failed to add the add-on you asked for once ended on
         * "Project ready." with status 0. A project missing something the
         * command line explicitly named is not ready, and a script that checked
         * the status could not tell. Not fatal: the scaffold around it is valid
         * and complete, and the fix is one `xanosdk marketplace install` away.
         *
         * No second warning here: each failed module's own `module.install-failed`
         * already carries npm's reason and the install command as its remedy
         * lines (E2E pass 28: three warnings for one failed add-on).
         */
        process.exitCode = EXIT_MODULE_INSTALL_FAILED;
      }
      if (outcome.legacyPeer.length > 0) {
        warn(
          `Installed with --legacy-peer-deps: ${outcome.legacyPeer.join(", ")}. ` +
            `npm refused the tree on peer ranges, so this one is not the tree npm would build on its own.`,
          "module.legacy-peer-deps",
        );
      }
    }

    // A CLI of another version than the one npm just installed (a global or
    // cached one, beside another release in the scaffold's range) rendered the derived files
    // — `.env.example`, the route table, AGENTS.md — in its own words, which
    // the project's `xano:check` (run by the installed CLI) calls stale. The
    // installed CLI re-renders them, as after an upgrade.
    if (result.install === "installed") {
      const { skewedProjectSdk } = await import("./project-sdk.js");
      const installedSdk = skewedProjectSdk(targetDir, readVersion());
      if (installedSdk !== undefined) {
        const { reconcileWithInstalled } = await import("./upgrade-command.js");
        const rendered = reconcileWithInstalled(targetDir);
        if (rendered.length > 0) {
          info(`Rendered ${rendered.join(", ")} with the installed @xano/sdk ${installedSdk.version} (this CLI is ${readVersion()}).`);
        }
      }
    }

    blank();
    // The headline has to agree with the warnings above it. "Project ready." over
    // a run that could not install what the command line named is the CLI
    // contradicting itself in its last line.
    const shortBy = moduleOutcome?.failed.length ?? 0;
    const manager = detectPackageManager(targetDir);
    const installLine = installCommandFor(targetDir);
    if (result.install === "failed") {
      // The project's OWN install failed: nothing in it can be loaded, exported
      // or deployed until it succeeds, so this is not "ready" and not exit 0. The
      // files stay — every one is correct, and `npm install` in place is the whole
      // repair, with no need to re-run `init` (which would refuse the non-empty
      // directory anyway).
      // The run's ending, not a second `init.install-failed` warning: the one
      // above already carries npm's reason, in the `--json` document too.
      fatal(`Project scaffolded, but its dependencies are NOT installed — ${manager} install failed (its reason is above).`);
      detail(`Fix what ${manager} reported, then run \`${installLine}\` in ${targetDir}. Nothing needs to be scaffolded again.`);
      process.exitCode = EXIT_MODULE_INSTALL_FAILED;
    } else if (entryFailed) {
      // Every file is written, but the entry the add-ons were wired into does
      // not load — `npm run build` and `xano:check` fail on the same error. Not
      // "ready", and not exit 0.
      fatal(`Project scaffolded, but it does not build yet — xano/index.ts fails to load (the reason is above).`);
      detail(`Fix xano/index.ts, then run \`npm run xano:export\` in ${targetDir}. Nothing needs to be scaffolded again.`);
      process.exitCode = EXIT_MODULE_INSTALL_FAILED;
    } else {
      success(
        shortBy === 0
          ? "Project ready."
          : `Project ready, without ${shortBy} add-on${shortBy === 1 ? "" : "s"}.`,
      );
    }
    // The add-ons named on the command line and not installed, in the ending
    // rather than as another warning — the reason is each one's warning above.
    if (moduleOutcome !== undefined && shortBy > 0) {
      const failed = moduleOutcome.failed;
      detail(
        `Not installed: ${failed.join(", ")} (${manager}'s reason is above). Add ${failed.length === 1 ? "it" : "them"} with ` +
          failed.map((pkg) => `\`${inProject(targetDir)}xanosdk marketplace install ${shellWord(pkg)}\``).join(", ") +
          ` once ${manager}'s error is fixed.`,
      );
    }
    const cdHint = targetDir === process.cwd() ? "" : `  cd ${shellWord(targetArg)}\n`;
    const needsInstall = !(result.install === "installed" || sdkResolves(targetDir));
    detail(
      `Next steps:\n` +
        cdHint +
        (needsInstall ? `  ${installLine}\n` : ``) +
        // A declared name with no line in xano/.env refuses the deploy, so the
        // step that supplies it comes first.
        (addonEnv.length > 0
          ? `  cp xano/.env.example xano/.env   # then set ${addonEnv.join(", ")} — the add-ons read ${addonEnv.length === 1 ? "it" : "them"}\n`
          : ``) +
        // The Xano Engine first: it needs no account, so sign-in waits for
        // the cloud deploy that does.
        `  npm run xano:deploy    # run the backend on the Xano Engine, on this machine\n` +
        (preset === null ? `` : `  npm run dev            # run the frontend, pointed at it\n`) +
        loginNextStep(pin, targetDir) +
        `${ephemeralNextStep(preset !== null)}\n` +
        `\n` +
        (hadLock !== undefined
          ? `xano/xano.lock was kept (${hadLock} ${hadLock === 1 ? "entry" : "entries"}). An entry the new xano/index.ts\n` +
            `does not export fails \`npm run xano:check\`; once those objects are gone for good,\n` +
            `\`${projectCli(targetDir)} lock prune ./xano/index.ts --yes\` drops them.`
          : (derived.includes(LOCK_REL)
              ? `xano/xano.lock was written for the add-ons' objects — commit it. It pins each\n`
              : `The first export or deploy writes xano/xano.lock — commit it. It pins each\n`) +
            `object's identity, so renaming one later renames it instead of deleting and\n` +
            `recreating it. See "xano.lock — commit it" in the README.`) +
        (derived.includes(ROUTES_REL)
          ? `\n${ROUTES_REL} was written for the add-ons' endpoints — commit it too.`
          : ""),
    );
    // One document for a machine reader, the same run `init --from` answers with
    // its decode report. Written last so a failed add-on (non-zero exit, project
    // left standing) is still described — `marketplace.failed` names it.
    if (isMachineOutput(args)) {
      writeJson({
        dir: targetDir,
        name: appName,
        // `new` or `existing`: whether this run wrote a project, or added the
        // backend to one that was already there.
        mode,
        framework: preset?.id ?? NO_FRONTEND,
        theme: preset === null ? null : choice.theme.id,
        dark: preset === null ? null : choice.dark,
        install: result.install,
        pinnedProfile,
        // Every file this run wrote or merged into, project-relative.
        files: runFiles(result.written, derived),
        // The one command to run next, from where `init` was typed.
        next: deployNextCommand(cdHint === "" ? null : targetArg, needsInstall ? installLine : null, manager),
        // `--no-install` still names what it added: recorded in package.json,
        // not installed, not wired.
        ...(moduleOutcome === undefined && deferredModules.length > 0
          ? {
              marketplace: {
                added: [...deferredModules],
                installed: [],
                failed: [],
                registered: [],
                unwired: [],
                toolchain: [],
              },
            }
          : {}),
        ...(moduleOutcome === undefined
          ? {}
          : {
              marketplace: {
                installed: moduleOutcome.installed,
                failed: moduleOutcome.failed,
                registered: moduleOutcome.registered.map((m) => m.pkg),
                unwired: moduleOutcome.unwired.map((m) => m.pkg),
                toolchain: moduleOutcome.toolchain,
              },
            }),
      });
    }
  } catch (err) {
    if (passOne !== undefined && !scaffolded) rollBackPassOne(passOne, err);
    throw err;
  }
}

const LOCK_REL = `${XANO_DIR}/xano.lock`;
const ROUTES_REL = `${XANO_DIR}/${ROUTES_MANIFEST_BASENAME}`;

/**
 * Record `--marketplace` add-ons in package.json without installing them
 * (`--no-install`). The version is the registry's current one as a caret range
 * — what `npm install <pkg>` would have written — or `latest` when the registry
 * cannot be asked; a specifier that already names a version or tag keeps it. A
 * local directory is recorded under its own package name as a `file:` spec.
 */
function recordDeferredModules(targetDir: string, specifiers: readonly string[]): void {
  const path = join(targetDir, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8")) as { dependencies?: Record<string, string> };
  const deps = { ...(pkg.dependencies ?? {}) };
  for (const specifier of specifiers) {
    const local = deferredDependency(specifier, targetDir);
    if (local !== undefined) {
      deps[local.name] = local.spec;
      continue;
    }
    const name = packageNameOf(specifier);
    const pinned = specifier.length > name.length + 1 ? specifier.slice(name.length + 1) : undefined;
    if (pinned !== undefined) {
      deps[name] = pinned;
      continue;
    }
    const view = npmViewVersion(name, targetDir);
    deps[name] = view.ok ? `^${view.version}` : "latest";
  }
  pkg.dependencies = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

/**
 * The dependency `--no-install` records for a non-registry specifier, or
 * undefined for a registry name. Only a local directory has a name to read
 * without installing it; a tarball, URL or git spec is refused, since
 * package.json keys every dependency by the name inside it.
 */
function deferredDependency(specifier: string, targetDir: string): { name: string; spec: string } | undefined {
  if (!isLocalSpecifier(specifier)) return undefined;
  const name = localPackageName(specifier, targetDir);
  if (name !== undefined) return { name, spec: `file:${localPathOf(specifier)}` };
  throw new UsageError(
    `\`--marketplace ${specifier}\` with \`--no-install\`: its package name is only known once it is installed, ` +
      `so it cannot be recorded in package.json. Drop --no-install, or add it once the project exists with ` +
      `\`${inProject(targetDir)}xanosdk marketplace install ${shellWord(specifier)}\`.`,
    { helpFor: { command: "init" } },
  );
}

/**
 * Write the files the scaffold's `xano:check` expects of a project that has
 * endpoints and identities — `xano/xano.lock` and `xano/routes.gen.ts` — from
 * the entry as it now stands. Returns the project-relative paths written.
 *
 * `init --marketplace` is the one plain-scaffold path that creates endpoints
 * itself: an add-on such as `@xano-sdk/auth` registers its tables and its API
 * group. Without this, the project it hands over fails its own check on the
 * first CI run, over files no step told anyone to generate. The lock is what
 * the first `export` writes (identities of the objects the entry registers,
 * canonicals minted where the code pins none), and the manifest is what
 * `routes --emit` writes against that lock — so both are byte-for-byte what
 * the check compares against.
 *
 * A courtesy, never a failure: an entry that cannot be loaded or exported here
 * leaves both for the first `npm run xano:export`, and says so.
 */
async function writeDerivedFiles(
  targetDir: string,
  renderIndexWithEnv: (env: readonly string[]) => string,
  /** The toolchain modules this run discovered, for their sections of the route manifest. */
  toolchain: Pick<Discovery, "loaded" | "skipped">,
): Promise<DerivedFiles> {
  const written: string[] = [];
  let declaredEnv: readonly string[] = [];
  const lockPath = join(targetDir, LOCK_REL);
  const routesPath = join(targetDir, ROUTES_REL);
  try {
    const { loadDefault, checkStandInTokens } = await import("./cli.js");
    const { Xano } = await import("../workspace/xano.js");
    const { createLockContext, lockKey, mergeObserved } = await import("../lock/lock.js");
    const { resetLockOverrides, seedLockOverrides } = await import("../lock/store.js");
    const { readLockFile, writeLockFile } = await import("../lock/io.js");
    const { setDiagnosticSink } = await import("../workspace/diagnostics.js");
    const { planRouteManifest } = await import("./routes-manifest.js");
    const { renderManifestFile, reportModuleFailures } = await import("./routes-manifest-file.js");
    const { isEnabled } = await import("./toolchain-modules.js");

    const existing = existsSync(lockPath) ? readLockFile(lockPath) : undefined;
    resetLockOverrides();
    if (existing !== undefined) seedLockOverrides(existing);
    const ctx = createLockContext(existing);
    const { envNamesRead } = await import("../workspace/guards.js");
    const { refreshEnvExample } = await import("./env-example-refresh.js");
    const def = await loadDefault(join(targetDir, XANO_DIR, "index.ts"));
    if (!Xano.isXano(def)) return { written, env: declaredEnv };
    // Muted: the export is read for identities and routes, and its warnings
    // describe a bundle nobody ships — `xano:check` reports them where they
    // are actionable. Doc gates get stand-ins: a token decides no identity.
    const previousSink = setDiagnosticSink(() => {});
    let payload: Record<string, unknown>;
    try {
      payload = def.export({ lock: ctx, documentationTokens: checkStandInTokens(def).values }).payload as Record<
        string,
        unknown
      >;
    } finally {
      setDiagnosticSink(previousSink);
    }
    // The env names the add-ons read, declared so the project's own strict
    // check has no `stack.env-undeclared` to fail on. Read off the export
    // rather than a list of modules: whatever a module reads is what is named.
    // A workspace config holds no lock identity, so the export above stands.
    const sections: Record<string, unknown[]> = {};
    for (const [key, value] of Object.entries(payload)) if (Array.isArray(value)) sections[key] = value;
    const env = envNamesRead(sections);
    if (env.length > 0) {
      writeFileSync(join(targetDir, XANO_DIR, "index.ts"), renderIndexWithEnv(env), "utf8");
      refreshEnvExample(join(targetDir, XANO_DIR), Object.fromEntries(env.map((name) => [name, ""])));
      declaredEnv = env;
    }
    const { lock } = mergeObserved(ctx.lock, ctx.observed);
    if (existing === undefined && Object.keys(lock.objects).length > 0) {
      writeLockFile(lockPath, lock);
      written.push(LOCK_REL);
    }
    // Each module with the config this run just RECORDED, not the config
    // discovery read before the questionnaire: the file has to be what the
    // project's own `xano:routes` writes from its package.json now, and a
    // module the answers switched off contributes nothing.
    const loaded = toolchain.loaded.flatMap((plugin) => {
      const config = readToolchainConfig(targetDir, plugin.pkg) ?? {};
      return isEnabled(config) ? [{ ...plugin, config }] : [];
    });
    const manifest = renderManifestFile(
      planRouteManifest(payload, (kind, name) => lock.objects[lockKey(kind, name)]?.canonical),
      {
        loaded,
        skipped: toolchain.skipped,
        previous: existsSync(routesPath) ? readFileSync(routesPath, "utf8") : undefined,
        sdkVersion: readVersion(),
      },
    );
    if (manifest !== undefined) {
      reportModuleFailures(manifest.failed, ROUTES_REL);
      writeFileSync(routesPath, manifest.source, "utf8");
      written.push(ROUTES_REL);
    }
  } catch (err) {
    // The same load `npm run build` and `xano:check` do, so a failure here is
    // the project not building — not a lock that is merely late.
    warn(
      `xano/index.ts does not load yet, so ${LOCK_REL} and ${ROUTES_REL} were not written: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      "init.lock-derive-failed",
      [`Fix xano/index.ts, then run \`npm run xano:export\` — it writes both.`],
    );
    return { written, env: declaredEnv, failed: true };
  }
  return { written, env: declaredEnv };
}

/** What {@link writeDerivedFiles} wrote, and whether the entry failed to load. */
interface DerivedFiles {
  readonly written: string[];
  /** Env names the add-ons read, now declared in xano/index.ts. */
  readonly env: readonly string[];
  readonly failed?: true;
}

/**
 * Refuse a profile NAMED for this run that this machine does not store, as
 * `whoami` and `status` do — typed with `--profile`, or set in `$XANO_PROFILE`.
 *
 * Nothing signed in and nothing named is the ordinary first run, and scaffolds
 * with no pin. But a name is a choice either way: scaffolding past one exited 0
 * with no pin and advice to log in, while the profile meant was stored under
 * another name — and `$XANO_PROFILE` is how CI and a shell profile name one, so
 * it is held to what the flag is. A pointer already in the target outranks the
 * environment, so a project that is already pinned is not refused over it.
 */
async function refuseUnknownProfileFlag(args: ParsedArgs, targetDir?: string): Promise<void> {
  const { ENV_PROFILE } = await import("../auth/profile-select.js");
  const envRaw = readEnvVar(ENV_PROFILE)?.trim();
  const fromEnv = args.profile === undefined && envRaw !== undefined;
  const name = args.profile ?? (fromEnv ? envRaw : undefined);
  if (name === undefined) return;
  if (fromEnv && targetDir !== undefined) {
    const { POINTER_FILE } = await import("../auth/profile-pointer.js");
    if (existsSync(join(targetDir, POINTER_FILE))) return;
  }
  const { readCredentialFile, resolveAuthFilePath, profileNames, loginHint } = await import("../auth/store.js");
  const path = resolveAuthFilePath(args, "read");
  const file = readCredentialFile(path);
  const stored = file === null ? [] : profileNames(file);
  if (stored.includes(name)) return;
  // The not-found failure (exit 8), the one `profile show <missing>` answers
  // with: the command was typed correctly and the stored state said no.
  const { ProfileNotFoundError } = await import("../auth/token.js");
  const have =
    stored.length === 0
      ? "Nothing is signed in on this machine."
      : `Stored profiles: ${quotedNames(stored)}.`;
  throw new ProfileNotFoundError(
    `No credential profile "${name}" in ${path} (from ${fromEnv ? `$${ENV_PROFILE}` : "--profile"}), so ` +
      `there is nothing to pin this project to. ${have} Run ${loginHint(name)} to add it, or name a ` +
      `stored one${fromEnv ? ` (or unset ${ENV_PROFILE})` : ""}.`,
    { name, source: fromEnv ? "env" : "flag" },
    stored,
  );
}

/** Whether the environment carries the meta credential triple (a partial one counts: it is not "nothing"). */
async function envCredentialSet(): Promise<boolean> {
  const { envMetaCredentialVarsSet } = await import("../auth/token.js");
  return envMetaCredentialVarsSet().length > 0;
}

/**
 * The `xanosdk login` line of the next steps — only on a machine with no
 * credential at all. Right after "Pinned to profile …" (or with profiles stored
 * and none pinned, where the remedy is `profile use`), telling the reader to
 * authenticate sends them to redo what is already done.
 */
export function loginNextStep(pin: Pick<ProfilePin, "signedIn">, projectDir: string): string {
  return pin.signedIn ? "" : `  ${projectCli(projectDir)} login       # authenticate with Xano\n`;
}

/** The `xano:deploy:ephemeral` line of the next steps, without its newline: a project with no frontend has none to build. */
export function ephemeralNextStep(frontend: boolean): string {
  return frontend
    ? `  npm run xano:deploy:ephemeral   # build the frontend, then deploy → live ephemeral URL`
    : `  npm run xano:deploy:ephemeral   # deploy the backend → live ephemeral URL`;
}

/**
 * The `--json` `next` command: the one command to run next, from where the
 * command was typed. `cdArg` is null when that is the project, `install` when
 * the project's install is not needed.
 */
export function deployNextCommand(cdArg: string | null, install: string | null, manager: string): string {
  return (cdArg === null ? "" : `cd ${shellWord(cdArg)} && `) + (install === null ? "" : `${install} && `) + `${manager} run xano:deploy`;
}

/** The `--json` `files` list: every path written, once each, sorted. */
export function runFiles(...groups: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(groups.flat())].sort();
}

/**
 * The CLI prefix for a closing step that runs in the project once its install
 * (a step itself when this run did not install) is done: what npx there
 * reaches, and `npx xanosdk` before that install exists.
 */
export function projectCli(projectDir: string): string {
  const prefix = cliPrefixAt(projectDir);
  return prefix === "xanosdk" || prefix === "npx @xano/sdk" ? "npx xanosdk" : prefix;
}

/**
 * Text written for a file inside the project, which spells `npx xanosdk`,
 * printed instead — each such command made to run from where `init` was typed.
 */
function runFromHere(text: string, targetDir: string): string {
  return text.replace(/`npx xanosdk /g, `\`${inProject(targetDir)}xanosdk `);
}

/**
 * Pin the new project to the profile this `init` ran under, in the committed
 * `xano.profile.json`.
 *
 * The point is that the SAFE state is the default. Without this, a fresh project
 * is aimed by whatever the running machine happens to resolve to — so the first
 * `deploy` from a laptop holding several profiles goes wherever the last `login`
 * left the default, and pinning is a repair someone has to know to make. The
 * pointer names a profile and nothing else, so it is safe to commit and carries
 * the pin to every machine that holds that profile.
 *
 * Three cases end without a pointer, and all of them are ordinary:
 *   • nothing signed in — the overwhelmingly common first run. `init` scaffolds
 *     without a credential and must keep doing so.
 *   • the resolved name is not a profile this machine stores — pinning to it
 *     would only move the failure to the next command, which would then blame
 *     the committed file for a name the shell supplied.
 *   • a pointer is already there. The pin is the project's own statement about
 *     where it belongs; `init --force` re-scaffolds files, it does not get to
 *     silently restate that.
 *
 * Returns the profile it pinned, or null when it wrote no pointer.
 *
 * Imported lazily because the credential store pulls its lock library and file
 * reads in with it, and a scaffold reaches this line once, at the very end.
 */
export interface ProfilePin {
  /**
   * The profile the project is pinned to once the scaffold lands — the one this
   * run pins, or the one an existing pointer already names — or null when the
   * project ends up unpinned.
   */
  readonly name: string | null;
  /**
   * Whether this machine holds ANY credential (a stored profile or the env
   * triple). The next steps suggest `xanosdk login` only when it does not.
   */
  readonly signedIn: boolean;
  /** The pointer file to write with the scaffold, when there is one. */
  readonly file: ScaffoldFile | null;
  /** Says what happened, once the files have landed. */
  report(): void;
}

/**
 * Decide the pin BEFORE the scaffold writes, so the pointer is one of the files
 * the scaffold lists and counts ("Wrote N files" names every file it wrote,
 * `xano.profile.json` included), and report it after.
 */
export async function planProfilePin(
  args: ParsedArgs,
  targetDir: string,
  /** `credentialRead`: the scaffold's source was read with a credential (`init --from` a hosted backend or release). */
  opts: { credentialRead?: boolean } = {},
): Promise<ProfilePin> {
  const { POINTER_FILE, readPointerFile } = await import("../auth/profile-pointer.js");
  const { readCredentialFile, resolveAuthFilePath, profileNames, loginHint } = await import("../auth/store.js");
  const credentialPath = resolveAuthFilePath(args, "read");
  const file = readCredentialFile(credentialPath);
  const signedIn = (file !== null && profileNames(file).length > 0) || (await envCredentialSet());
  const pointerPath = join(targetDir, POINTER_FILE);
  if (existsSync(pointerPath)) {
    let pinned: string | null = null;
    try {
      pinned = readPointerFile(pointerPath) ?? null;
    } catch {
      // An unreadable pointer is the next command's to refuse, by name.
    }
    // A kept pin to a profile this machine does not store is noted: `-p nosuch`
    // is refused (exit 8), and keeping the same name silently from the file
    // would leave the next command to fail with no warning here. An env
    // credential stands in for a stored profile, so it is not flagged then.
    const unknownPin =
      pinned !== null && !(file !== null && profileNames(file).includes(pinned)) && !(await envCredentialSet());
    return {
      // What the project IS pinned to — `init --force` over a pinned target
      // keeps the pin, so reporting null here said the opposite of the file.
      name: pinned,
      signedIn,
      file: null,
      report: () => {
        detail(`Already pinned: ${POINTER_FILE} is left as it is.`);
        if (unknownPin) {
          warn(
            `${POINTER_FILE} pins profile "${pinned}", which this machine does not have — commands here ` +
              `will fail until you run ${loginHint(pinned!)}, or re-pin with \`${inProject(targetDir)}xanosdk profile use <name>\`.`,
            "profile.pin-missing",
          );
        }
      },
    };
  }

  // The read used the environment credential, which outranks every stored
  // profile: pinning the file's default would name a profile nothing here
  // read with — possibly another instance altogether (E2E pass 18).
  if (opts.credentialRead === true) {
    const { environmentCredentialVars } = await import("../auth/token.js");
    const env = environmentCredentialVars();
    if (env.complete) {
      return {
        name: null,
        signedIn,
        file: null,
        report: () =>
          detail(
            `Not pinned: this read used the environment credential (${env.vars.join(", ")}), not a stored ` +
              `profile. To pin one, run \`${inProject(targetDir)}xanosdk profile use <name>\` — it writes ${POINTER_FILE}.`,
          ),
      };
    }
  }

  const { resolveActiveProfile } = await import("../auth/profile-select.js");
  const selection = resolveActiveProfile({
    flag: args.profile,
    fileDefault: file?.default,
    // Nothing is pinned yet — that is what this function is about to decide —
    // so the pointer rung has nothing to contribute to its own creation.
    readPointer: () => undefined,
  });
  const stored = file === null ? [] : profileNames(file);
  if (!stored.includes(selection.name)) {
    // Said out loud, because the missing file is the difference between a
    // project that knows its target and one that guesses on every command.
    // Advice to sign in is only right when nothing is signed in: with profiles
    // stored, the gap is that none of them is the one this run resolved to; with
    // none stored and a complete environment credential, commands here already
    // act through that credential, and signing in is not the next step.
    const env = stored.length === 0 ? (await import("../auth/token.js")).environmentCredentialVars() : undefined;
    const storeEnv = env?.complete === true ? await storeEnvCredentialCommand(credentialPath, targetDir) : "";
    return {
      name: null,
      signedIn,
      file: null,
      report: () =>
        detail(
          env?.complete === true
            ? `Not pinned: commands here use the environment credential (${env.vars.join(", ")}), not a stored ` +
                `profile. To pin it, store it as a profile and pin that: ` +
                `\`${storeEnv}\` — it writes ${POINTER_FILE}.`
            : stored.length === 0
            ? `Not pinned: no signed-in profile to pin to yet. ` +
                `Run \`${inProject(targetDir)}xanosdk login && xanosdk profile use <name>\` to write ${POINTER_FILE}.`
            : `Not pinned: none of the signed-in profiles (${quotedNames(stored)}) is ` +
                `the default. Run \`${inProject(targetDir)}xanosdk profile use <name>\` to write ${POINTER_FILE}.`,
        ),
    };
  }
  // A complete environment credential outranks the pin on every command here,
  // so pinning a file default that addresses another backend would aim clones
  // somewhere this session never acts on. A named profile (`--profile`,
  // `$XANO_PROFILE`) is a deliberate choice and is still pinned.
  if (selection.source === "file-default" || selection.source === "implicit") {
    const elsewhere = await envAddressesElsewhere(file!, selection.name, credentialPath);
    if (elsewhere !== null) {
      return {
        name: null,
        signedIn,
        file: null,
        report: () =>
          detail(
            `Not pinned: commands here use the environment credential (${elsewhere.env}), not the default ` +
              `profile "${selection.name}" (${elsewhere.stored}). To pin "${selection.name}" deliberately, run ` +
              `\`${inProject(targetDir)}xanosdk profile use ${shellWord(selection.name)}\` — it writes ${POINTER_FILE}.`,
          ),
      };
    }
  }
  const { writePointerFile } = await import("../auth/profile-pointer.js");
  return {
    name: selection.name,
    signedIn,
    // The same bytes `writePointerFile` writes.
    file: { path: POINTER_FILE, content: `${JSON.stringify({ profile: selection.name }, null, 2)}\n` },
    report: () => {
      // A scaffold that refreshes only `xano/` in an existing project writes
      // none of the root files, this one included — so it is written here.
      if (!existsSync(join(targetDir, POINTER_FILE))) writePointerFile(targetDir, selection.name);
      info(`Pinned to profile "${selection.name}" in ${POINTER_FILE} — commit it, so every clone deploys here.`);
    },
  };
}

/**
 * When the environment carries a complete meta credential for another instance
 * or workspace than the stored profile `name`: both targets, described.
 */
async function envAddressesElsewhere(
  file: import("../auth/store.js").CredentialFile,
  name: string,
  credentialPath: string,
): Promise<{ env: string; stored: string } | null> {
  const instance = readEnvVar("XANO_INSTANCE_URL")?.trim();
  const workspace = readEnvVar("XANO_WORKSPACE_ID")?.trim();
  if (instance === undefined || workspace === undefined || readEnvVar("XANO_META_TOKEN") === undefined) return null;
  const { readProfile, sameOriginAs } = await import("../auth/store.js");
  let record: import("../auth/store.js").CredentialRecord | null;
  try {
    record = readProfile(file, name, credentialPath);
  } catch {
    return null;
  }
  if (record === null) return null;
  const storedInstance = record.type === "token" ? record.instance_base_url : record.instance;
  if (sameOriginAs(storedInstance, instance) && String(record.workspace_id) === workspace) return null;
  return {
    env: `workspace ${workspace} on ${instance}`,
    stored: `workspace ${record.workspace_id} on ${storedInstance}`,
  };
}

/**
 * The one command that stores the environment credential as the `default`
 * profile and pins the project at `targetDir` to it, spelled from where `init`
 * was typed. The meta token is piped from its variable, never printed; the
 * instance and workspace are filled in from theirs, since `profile add` reads
 * only its flags. A refresh-token credential has no token to pipe, so that one
 * signs in instead.
 */
async function storeEnvCredentialCommand(credentialPath: string, targetDir: string): Promise<string> {
  const { credentialFileFlag, profileAddCommand } = await import("../auth/store.js");
  const { DEFAULT_PROFILE } = await import("../auth/profile-select.js");
  const instance = readEnvVar("XANO_INSTANCE_URL");
  const workspaceId = readEnvVar("XANO_WORKSPACE_ID");
  const flag = credentialFileFlag(credentialPath);
  const store =
    instance !== undefined && workspaceId !== undefined && readEnvVar("XANO_META_TOKEN") !== undefined
      ? `printf %s "$XANO_META_TOKEN" | ${profileAddCommand(DEFAULT_PROFILE, { path: credentialPath, instance, workspaceId: workspaceId.trim() })}`
      : `xanosdk login${flag}`;
  return `${inProject(targetDir)}${store} && xanosdk profile use ${DEFAULT_PROFILE}${flag}`;
}

/** Whether `@xano/sdk` resolves from `dir` — in its own node_modules, or hoisted to a workspace root's. */
function sdkResolves(dir: string): boolean {
  return readInstalledManifestState(dir, "@xano/sdk").kind !== "absent";
}
