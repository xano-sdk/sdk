/**
 * File templates for `xanosdk init` — the "perfect Xano SDK project" distilled
 * to the smallest thing that compiles, deploys, and demonstrates the one
 * contract (frontend paths/types derived from the backend defs).
 *
 * Layout: `xano/` (the Xano SDK backend) and `frontend/` (the Vite app) as peer
 * top-level folders under a single root `package.json`. Vite's root is pinned
 * to `frontend/` (see {@link renderViteConfig}) so `index.html` and the build
 * both live there without npm workspaces.
 *
 * Everything here is framework-agnostic. Which UI framework fills `frontend/`
 * is a {@link FrontendPreset} (see `frontend-presets.ts`), and the templates
 * that vary by framework — dependency set, typecheck command, tsconfig
 * `compilerOptions`, the Vite plugin list, the `index.html` entry — take one.
 *
 * Templates are inlined string builders (not a shipped `templates/` directory)
 * so they are always available at runtime regardless of packaging — the same
 * reason the CLI avoids `__dirname` asset resolution across `npx`/`file:`
 * installs. Each builder takes already-resolved, already-sanitized values.
 */
import type { FrontendPreset, LandingContent } from "./frontend-presets.js";
import type { PackageManager } from "./package-manager.js";
import type { ProjectCli } from "./invocation.js";
import { composeBlock, gitattributesSpec, upsertBlock } from "./managed-blocks.js";
import { decodeMarkerWith } from "./decode-record.js";
import {
  colorTokens,
  defaultThemeChoice,
  fontDependencies,
  fontImports,
  fontThemeVars,
  orderedTokens,
  type DarkMode,
  type ThemeChoice,
} from "./theme-presets.js";

/** Inputs every template may need. `appName` is a valid npm package name; `sdkVersion` is the running CLI's version (or `"unknown"`). */
export interface TemplateVars {
  appName: string;
  sdkVersion: string;
  /** How the project installs; npm, standalone, when omitted. */
  install?: ProjectInstall;
  /** The prefix the project's files spell commands with (`npx xanosdk` when omitted); see `projectFileCli`. */
  cli?: ProjectCli;
  /** Where the project's files say the SDK is installed (`node_modules/@xano/sdk` when omitted); see `projectSdkDir`. */
  sdkDir?: string;
}

/** How a scaffolded project installs its dependencies — what its CI and README spell. */
export interface ProjectInstall {
  readonly manager: PackageManager;
  /**
   * The project's POSIX path below the workspace root that holds the lockfile,
   * or `""` when the project installs in place.
   */
  readonly member: string;
  /** The workspace root's `packageManager` field names the manager, so its setup reads the version there. */
  readonly declared: boolean;
  /** The manager's version, when known. */
  readonly version?: string;
  /** pnpm would install an enclosing workspace that does not list this project, so every install passes `--ignore-workspace`. */
  readonly ignoreWorkspace?: boolean;
  /**
   * The POSIX path below the git repository's top level of the directory that
   * installs (the workspace root, or the project itself) — absent when that
   * directory is the top level, or no repository encloses it.
   */
  readonly repoDir?: string;
}

const STANDALONE_NPM: ProjectInstall = { manager: "npm", member: "", declared: false };

/**
 * The `@xano/sdk` dependency range for the scaffold's `package.json`. Floors
 * at the running CLI's version so the project matches the tool that created it,
 * and caps at the next major, as a caret does. A `0.0.x` version is the one
 * exception: a caret there is an exact pin, so the ceiling opens up to the whole
 * `0.x` minor instead. Falls back to `>=1.0.0 <2.0.0` when the version can't be
 * resolved (`"unknown"`).
 *
 * The ceiling is DERIVED from the version, never a literal: a hardcoded ceiling
 * would emit an unsatisfiable range the day the version reaches it.
 */
export function sdkDep(sdkVersion: string): string {
  const parsed = /^(\d+)\.(\d+)\.\d+/.exec(sdkVersion);
  if (!parsed) return ">=1.0.0 <2.0.0";
  const [major, minor] = [Number(parsed[1]), Number(parsed[2])];
  const ceiling = major > 0 ? `${major + 1}.0.0` : `0.${minor + 1}.0`;
  return `>=${sdkVersion} <${ceiling}`;
}

/** A copy of a string map with its keys in npm's own order (`localeCompare`, "en"). */
function sortedKeys(map: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b, "en")));
}

export function renderPackageJson(
  { appName, sdkVersion }: TemplateVars,
  preset: FrontendPreset,
  choice: ThemeChoice = defaultThemeChoice(),
): string {
  // The framework's typecheck command, prefixed onto every script that needs
  // one. `tsc --noEmit` alone cannot see inside `.svelte` files, so this is a
  // preset contribution rather than a literal — see FrontendPreset.checkCmd.
  // Then the lambda modules, under their own config (see renderLambdaTsconfig).
  const check = `${preset.checkCmd} && tsc -p xano/lambdas`;
  // The frontend takes endpoint paths from `xano/routes.gen.ts`, generated from
  // the defs. Every script that type-checks or builds regenerates it first, so a
  // renamed endpoint is a compile error rather than a 404. It writes nothing
  // until the workspace has an endpoint.
  const routes = "xanosdk routes ./xano/index.ts --emit xano/routes.gen.ts";
  const pkg = {
    name: appName,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "npm run xano:routes && vite",
      build: `npm run xano:routes && ${check} && vite build`,
      preview: "vite preview",
      typecheck: `npm run xano:routes && ${check}`,
      "xano:routes": routes,
      // Both are prefixed with a typecheck: the export pass validates what it
      // can see in the encoded bundle, and TypeScript validates the rest. With
      // `tsc` on `build` alone, anyone following the documented workflow would
      // ship with the compiler's half of the checks never run.
      // No `--lock` on either of these: every build maintains `xano/xano.lock`
      // by default, so the flag would be redundant here and would read as
      // though the lock were something a project opts into. It is not — object
      // identity derives from `(type, name)`, and without a lock a rename
      // re-derives the guid and the engine does delete-and-recreate instead of
      // rename-in-place, so the file has to exist before the identities matter.
      // Scaffolds written before the default flipped still pass `--lock`, and
      // it stays accepted for exactly that reason.
      "xano:export": `npm run xano:routes && ${check} && xanosdk export ./xano/index.ts --out workspace.json`,
      // Runs `build` rather than `check` directly: `--static ./frontend/dist`
      // needs that directory to EXIST, and only `vite build` writes it. Pointing
      // the flag at a directory the script never produced meant a fresh clone
      // running the one documented command had no `dist` to ship.
      // `build` already prefixes the same typecheck, so this is one check, not
      // two.
      "xano:deploy": `npm run build && xanosdk deploy ./xano/index.ts --static ./frontend/dist`,
      // The tight loop: redeploy the backend to an engine on this machine.
      //
      // No `--static` and no `npm run build`, and both omissions are the point
      // rather than an economy: there is no frontend to ship here. The dev
      // server is still serving it, and the deploy points that server at the
      // engine on its way past, so the loop is backend-only by design.
      // (`--static` does work on a local engine, for a built frontend the
      // engine itself should serve; this loop has none.)
      //
      // The flag is bare deliberately. The engine's download URL is passed by
      // hand once and cached for every run after; baking one into a scaffolded
      // project would ship a coordinate that is not this project's to carry.
      //
      // `--keep-data`, because the engine is the developer's own backend and
      // this loop runs once per code change: each run merges into what the last
      // one left, so rows entered through the app survive the edit. The first
      // run, and the first after the engine restarts, replaces and seeds.
      // `--reset` on the command line still gives a clean slate.
      "xano:deploy:local-engine": `npm run xano:routes && ${check} && xanosdk deploy ./xano/index.ts --local-engine --keep-data`,
      // The frontend-only loop: rebuild and republish to the environment this
      // project last deployed to, without recompiling or re-importing the
      // backend. `build` runs first because publish ships only what is on disk.
      "xano:deploy:frontend": "npm run build && xanosdk publish ./frontend/dist",
      // The CI guard: fails instead of changing xano.lock, so an uncommitted
      // identity change is caught in review rather than on a deploy. An
      // installed toolchain module's own check rides on the same run: a module
      // that owns a generated tree verifies it under this same flag.
      // `--strict` fails on a stale or missing committed manifest rather than
      // rewriting it, the same way `--frozen-lock` treats xano.lock.
      //
      // `export --check`, not an export to a file: a CI checkout has no
      // `xano/.env` and no `xano/.secrets.json`, and a real export refuses a
      // declared documentation gate it cannot supply. The check writes nothing
      // — no bundle, no lock — so there is nothing a missing secret could clear,
      // and it needs none. It implies `--frozen-lock`. `--strict` as the grounding
      // tells every CI and unattended build to: a build warning is a hard
      // failure. Env values never reach it — a declared name with no value is
      // `""`, which only `deploy` refuses — so a checkout with no `xano/.env`
      // passes it (a fresh scaffold and an `init --from` tree both do).
      "xano:check": `${routes} --strict && ${check} && xanosdk export ./xano/index.ts --check --strict`,
      // No compile step and no entry file: this runs what is DEPLOYED, so it
      // pairs with `xano:deploy` rather than repeating its work. Exits 5 on a
      // failing suite, which is what makes it usable as a CI gate.
      "xano:test": "xanosdk test run-all",
      // Framework-owned scripts, last so a preset can add to the set but the
      // shared xano:* contract above stays the same in every scaffold.
      ...preset.extraScripts,
    },
    // Sorted, as npm writes them: an unsorted map is reordered by the first
    // `npm install`, a diff in a file nobody edited.
    dependencies: sortedKeys({
      // `@xano/sdk` is the only Xano SDK dependency a scaffold ships with.
      // Add-ons (`@xano-sdk/auth`, and the packages that follow it) are installed
      // on demand — a project that never registers auth should not carry it,
      // and an add-on's release cadence is its own, not the CLI's.
      "@xano/sdk": sdkDep(sdkVersion),
      ...preset.dependencies,
      // The icon set and the typefaces are choices, not framework constants, so
      // they are merged here rather than sitting in `preset.dependencies`. Both
      // land after the preset's own entries: a preset that still names an icon
      // package would otherwise win over the set the user actually picked.
      ...preset.iconBinding(choice.icons).dependency,
      ...fontDependencies(choice.fonts),
    }),
    devDependencies: sortedKeys({ ...preset.devDependencies }),
    // Not ">=20": Vite 8 and vite-plugin-svelte 7 both declare
    // `^20.19 || >=22.12`, so 20.0–20.18 installs the toolchain and then fails
    // to run it. Stating the real floor turns that into an install-time
    // warning instead of a confusing crash.
    engines: { node: `>=${NODE_MIN}` },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

export function renderTsconfig(preset: FrontendPreset): string {
  // The alias this framework's UI kit generates its imports against — `@/*`
  // for shadcn/ui. Mirrored in vite.config.ts; both halves are needed
  // (TypeScript resolves types, Vite resolves the bundle). Omitted entirely
  // when the framework generates its own paths, so the file never carries a
  // second mapping that can drift from the generated one.
  //
  // No `baseUrl`. TypeScript 6 deprecates it — `tsc` FAILS with TS5101 rather
  // than warning — and it has been unnecessary since 5.0: a `paths` target is
  // resolved against this file's own directory when no baseUrl is set, which
  // is what `.` meant here anyway. Preset targets are written `./…` for that
  // reason.
  const aliasPaths =
    Object.keys(preset.tsconfigPaths).length > 0 ? { paths: { ...preset.tsconfigPaths } } : {};
  const tsconfig = {
    // Present only when the framework generates a config to build on — see
    // FrontendPreset.tsconfigExtends. The `include` below is re-declared on
    // top of it deliberately: an extended config's `include` is REPLACED, not
    // merged, and dropping `xano` here would leave the backend unchecked while
    // every command still exits 0.
    ...(preset.tsconfigExtends === undefined ? {} : { extends: preset.tsconfigExtends }),
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "bundler",
      ...preset.tsconfigOptions,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      skipLibCheck: true,
      resolveJsonModule: true,
      isolatedModules: true,
      types: ["node", "vite/client"],
      ...aliasPaths,
    },
    // Both halves of the project typecheck together: the Xano SDK backend and
    // the frontend that derives its types from the backend's defs. A preset
    // that extends a generated config appends whatever that config listed —
    // `include` is replaced, not merged, so anything it declared is otherwise
    // silently dropped. See FrontendPreset.tsconfigInclude.
    include: ["xano", "frontend/src", ...(preset.tsconfigInclude ?? [])],
    // The lambda modules type-check under their own config, which declares the
    // lambda runtime's globals; see renderLambdaTsconfig.
    exclude: ["node_modules", "xano/lambdas"],
  };
  return JSON.stringify(tsconfig, null, 2) + "\n";
}

/** The package entry `xano/lambdas/tsconfig.json` loads the lambda globals through. */
export const LAMBDA_GLOBALS_TYPES = "@xano/sdk/lambda-globals";

/**
 * `xano/lambdas/tsconfig.json` — the config `lam.file` modules type-check
 * under. The lambda runtime's globals (`DateTime`, `_`, `crypto.createHmac`,
 * its `fetch`) are global declarations, so in the project's one program they
 * would reach the frontend too: `fetch()` there would resolve to the lambda
 * runtime's response. Here they apply to this directory only, which the
 * project config excludes and `typecheck` checks with `tsc -p xano/lambdas`.
 * The declarations load through `types` — package resolution, so they are found
 * wherever the package manager put `@xano/sdk` (a hoisted workspace keeps it
 * in the workspace root's node_modules, not this project's). `files: []` lets
 * the config build with no lambda written yet: tsc refuses a config whose
 * `include` matches nothing unless `files` is present.
 */
export function renderLambdaTsconfig(): string {
  const tsconfig = {
    extends: "../../tsconfig.json",
    // No DOM and no node types: a lambda body runs in neither.
    compilerOptions: { lib: ["ES2022"], types: [LAMBDA_GLOBALS_TYPES] },
    files: [],
    include: ["**/*.ts"],
    exclude: [],
  };
  return JSON.stringify(tsconfig, null, 2) + "\n";
}

export function renderViteConfig(preset: FrontendPreset): string {
  const root = preset.viteRoot === undefined ? "frontend" : preset.viteRoot;
  const build = preset.viteBuild === undefined ? { outDir: "dist", emptyOutDir: true } : preset.viteBuild;

  const header =
    root === null
      ? `// Vite's root is the project root. The framework resolves its own file
// locations from the plugin config below — this file is the ONLY place that
// config lives — and routes the build through its adapter, which writes
// frontend/dist, the directory \`npm run xano:deploy\` ships as the frontend.`
      : `// Vite's root is the ${root}/ folder, so index.html and the app live there
// while the Xano SDK backend sits in xano/ as a peer. The build lands in
// ${root}/dist, which \`npm run xano:deploy\` ships as the static frontend.`;

  // Vite resolves `.env` files against `root`, so with root at frontend/ a
  // `.env.local` placed beside `.env.example` at the project root is silently
  // ignored. Pointing envDir back at this file's own directory fixes that —
  // and is unnecessary when root already IS this directory.
  const rootBlock =
    root === null
      ? ""
      : `  root: ${JSON.stringify(root)},
  // Vite resolves \`.env\` files against \`root\`, which is ${root}/ here — but
  // \`.env.example\` sits at the project root, so that is where anyone will
  // actually put their \`.env.local\`. Point envDir back at this file's own
  // directory so VITE_XANO_HOST is picked up in dev.
  envDir: fileURLToPath(new URL(".", import.meta.url)),
`;

  const buildBlock = build === null ? "" : `  build: ${renderInlineObject(build)},\n`;

  const aliasBlock =
    preset.aliasName === null
      ? ""
      : `  resolve: {
    alias: {
      // The alias the UI kit writes its imports against. Resolved from this
      // file rather than from Vite's root so it points at the right directory
      // either way. Keep in sync with the \`paths\` entry in tsconfig.json.
      "${preset.aliasName}": fileURLToPath(new URL("./${preset.aliasTarget}", import.meta.url)),
    },
  },
`;

  // `fileURLToPath` is referenced only by the two blocks above. Importing it
  // unused would read as dead code in a file users open and edit.
  const fileUrlImport =
    rootBlock === "" && aliasBlock === "" ? "" : `import { fileURLToPath } from "node:url";\n`;

  return `${fileUrlImport}import { defineConfig } from "vite";
${preset.viteImports.join("\n")}

${header}
export default defineConfig({
${rootBlock}${buildBlock}  plugins: [${preset.vitePlugins.join(", ")}],
${aliasBlock}  server: { host: "127.0.0.1", port: 5173 },
});
`;
}

/** `{ outDir: "dist", emptyOutDir: true }` — a one-line object literal, as hand-written. */
function renderInlineObject(obj: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(obj).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

export function renderIndexHtml(
  { appName }: TemplateVars,
  preset: FrontendPreset,
  choice: ThemeChoice = defaultThemeChoice(),
): string {
  // Only reached for presets that use the shared HTML entry — see
  // FrontendPreset.ownsHtmlEntry, which gates the caller.
  if (preset.entryScript === undefined) {
    throw new Error(`The ${preset.id} preset owns its own HTML entry; renderIndexHtml does not apply.`);
  }
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${appName}</title>
${renderThemeScript(choice.dark)}  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${preset.entryScript}"></script>
  </body>
</html>
`;
}

export function renderGitignore(preset?: FrontendPreset): string {
  // `xano/xano.lock` is deliberately absent — it is COMMITTED (see the README's
  // "xano.lock — commit it"). Listed here as a comment so nobody adds it back
  // while tidying the compiled artifacts around it.
  const framework = (preset?.gitignoreEntries ?? []).map((e) => `${e}\n`).join("");
  return `node_modules/
dist/
workspace.json
.xano/
.env
.env.tmp-*
.env.local
*.local
.secrets.json
.secrets.json.tmp-*
${framework}
# Ignored, on purpose: the bare \`.env\` above has no slash, so it matches at ANY
# depth — including xano/.env, which holds the VALUES of this backend's env vars.
# Its committed template is xano/.env.example, which lists the names only.
#
# \`.secrets.json\` is the second exception, and the same rule applies to it: it
# matches at any depth, so it covers xano/.secrets.json, which holds the tokens a
# pull brought down and a deploy sends back. The SDK writes that file; nobody
# edits it. The \`.tmp-*\` lines cover the staging file an atomic write of
# either leaves behind if the process dies between writing and renaming.
#
# Those two files are the sole exceptions inside an otherwise fully committed
# xano/. Do not "tidy" this by ignoring xano/ wholesale — the source is the
# review surface.
#
# Not ignored, on purpose: xano/xano.lock pins object identity and public URLs
# across renames and environments. Every build writes it. Commit it — ignoring
# it means each build mints identities that are thrown away and re-invented.
`;
}

/**
 * The Node version CI pins and `engines` declares. One constant so the workflow
 * cannot drift from the range a project claims to support.
 */
export const NODE_MIN = "20.19";

/**
 * `.gitattributes` — the line-ending rule every generated tree depends on.
 *
 * The export writes LF. Normalizing here keeps any committed rendering
 * byte-identical on every checkout, so a `--frozen-lock` check cannot fail over
 * a contributor's `core.autocrlf` setting rather than over a real change.
 *
 * A module that owns a generated tree contributes the rules that make it render
 * and diff well on GitHub through the toolchain-module contribution hook. That
 * is the point of the slot — a module that owns a directory owns how it
 * displays.
 */
export interface GitattributesContribution {
  /** The contributing package, which keys its block. */
  readonly pkg: string;
  /** That package's own version, stamped into the block. */
  readonly version: string;
  /** The rules it contributes. An empty list contributes no block at all. */
  readonly lines: readonly string[];
}

/**
 * Render `.gitattributes`: the SDK's own header, then one MARKED BLOCK per
 * contributing package.
 *
 * The markers are the whole point. A scaffolded project has to be re-appliable
 * — a module installed later, re-configured, or removed is reconciled in place
 * — and that is only possible if the span each package owns can be found again.
 * So contributions arrive grouped BY PACKAGE rather than flattened: whose line
 * was whose is what decides which block it lands in.
 *
 * Blocks are emitted in whatever order discovery yields. Nothing compares this
 * file across two projects — `npm run xano:check` compares the exported
 * workspace against `xano.lock` and never reads `.gitattributes` — so there is
 * no ordering rule to enforce and no byte parity to preserve between `init` and
 * a later reconcile.
 *
 * Composed through {@link upsertBlock} rather than by concatenation, so the
 * output is by construction a fixed point of the same splice the reconciler
 * runs: re-applying an unchanged contribution reports no change.
 */
export function renderGitattributes(
  contributions: readonly GitattributesContribution[] = [],
): string {
  // The `*` rule is the SDK's own and stays outside every block. It applies to
  // every path in the repository, which is exactly why a MODULE may never
  // contribute one (`assertUsableContributions` refuses it) — and why the
  // reconciler, creating this file from scratch, does not write one either.
  let text = `# The export writes LF. Normalizing here keeps generated output
# byte-identical on every checkout, so \`npm run xano:check\` cannot fail over a
# contributor's core.autocrlf setting rather than over a real change.
* text=auto eol=lf
`;
  for (const { pkg, version, lines } of contributions) {
    // The same block identity the reconciler splices with — see
    // `gitattributesSpec`. Two definitions would let `init` write a block a
    // later reconcile appends beside instead of replacing.
    const spec = gitattributesSpec(pkg);
    // Contributed lines land AFTER the SDK's own header, so a module refines
    // the defaults rather than racing them.
    text = upsertBlock(text, spec, composeBlock(spec, lines, version)).text;
  }
  return text;
}

/**
 * The CI workflow — what makes `xano.lock`, and any derived artifact a
 * toolchain module commits, trustworthy.
 *
 * `npm run xano:check` already exits non-zero on a stale lock and names what
 * would change, but nothing ran it, so the guarantee held only by convention. A
 * stale derived artifact is worse than none, because a reviewer reads it as
 * authoritative.
 *
 * It also catches the case no conflict ever surfaces: two branches that touch
 * different objects merge cleanly while one side's derived state was computed
 * against the other's pre-merge source. GitHub runs `pull_request` jobs against
 * `refs/pull/N/merge`, a simulated merge with the current base, so the check
 * sees that tree before it lands. Pair it with "Require branches to be up to
 * date before merging" so a PR approved against an older base is re-checked.
 *
 * No `cache: npm`: setup-node fails when it cannot find a lockfile to key the
 * cache on, and `init --no-install` leaves a tree that has none yet. The install
 * is a second or two; a workflow that fails on a fresh scaffold is not.
 *
 * The install is the project's own manager's, frozen to its lockfile when one is
 * committed. A workspace member installs at the workspace root and runs its
 * checks in its own directory; GitHub reads workflows only from the
 * repository's root, so the file says to move it there.
 *
 * There is no slot for a module to contribute steps, and that is deliberate: a
 * toolchain module's frozen check ALREADY rides on `npm run xano:check` through
 * its `onBundle` hook with `frozen: true`, so a contributed step solved a
 * problem the hook had already solved. It also had to be spliced into a file
 * the SDK does not always own — a renamed job, a build matrix, or simply no
 * workflow at all each had to be refused, which would have meant a project with
 * no GitHub Actions workflow could never install a toolchain module.
 */
/** Where the project's checks run, relative to the repository root — empty at the top level. */
export function checkJobDir(install: ProjectInstall | undefined): string {
  return [install?.repoDir ?? "", install?.member ?? ""].filter((p) => p !== "").join("/");
}

/**
 * The check workflow's file name, without its directory. `check.yml` at the
 * repository's top level; below it the file is moved up to the root's
 * `.github/workflows/`, where the repository's own workflows and every other
 * project's live — so it is named for the project and a move never replaces one.
 */
export function checkWorkflowName(install: ProjectInstall | undefined): string {
  const jobDir = checkJobDir(install);
  if (jobDir === "") return "check.yml";
  const slug = jobDir.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  return `xanosdk-${slug === "" ? "project" : slug}.yml`;
}

/** The project-relative path {@link renderCheckWorkflow}'s file is written to. */
export function checkWorkflowPath(install: ProjectInstall | undefined): string {
  return `.github/workflows/${checkWorkflowName(install)}`;
}

export function renderCheckWorkflow(install: ProjectInstall = STANDALONE_NPM): string {
  const { manager, member } = install;
  const repoDir = install.repoDir ?? "";
  const jobDir = checkJobDir(install);
  const name = jobDir === "" ? "check" : checkWorkflowName(install).replace(/\.yml$/, "");
  const memberNote =
    member !== ""
      ? `# This project is the workspace member ${member}. GitHub runs workflows only
# from the repository root's .github/workflows/, so move this file there. Its
# steps assume the workspace root is ${repoDir === "" ? "the repository root" : `${repoDir}/ in the repository`}: the install runs
# there, every other step in ${jobDir}.
`
      : repoDir !== ""
        ? `# This project is ${repoDir}/ in its git repository. GitHub runs workflows
# only from the repository root's .github/workflows/, so move this file there.
# Its steps run in ${repoDir}.
`
        : "";
  const defaults = jobDir === "" ? "" : `    defaults:\n      run:\n        working-directory: ${JSON.stringify(jobDir)}\n`;
  const atRoot = member === "" ? "" : `        working-directory: ${repoDir === "" ? "." : JSON.stringify(repoDir)}\n`;
  return `${memberNote}name: ${name}

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
${defaults}    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '${NODE_MIN}'
${managerSetup(install)}
      # A frozen install whenever a lockfile is committed: package.json allows a
      # @xano/sdk range that the lock pins, and an open install would rebuild
      # derived state with whatever patch shipped most recently, failing the
      # check below on a change that touched nothing relevant. The fallback
      # covers a tree scaffolded with \`--no-install\`, which has no lockfile yet.
      - name: Install
${atRoot}        run: ${frozenInstall(manager, install.ignoreWorkspace === true)}

      # The gate. Typechecks, then runs
      # \`npx xanosdk export ./xano/index.ts --check --strict\`: every check an export runs,
      # writing nothing, so it needs no secrets. It fails instead of rewriting
      # when xano.lock disagrees with the source, naming what would change.
      # It also fails while the lock carries an entry no exported object
      # matches, which is how a rename looks until its identity is moved across
      # with \`npx xanosdk lock rename\` (or dropped with \`npx xanosdk lock prune\`). An
      # installed toolchain module's own frozen check rides on this same run.
      - name: Typecheck, check the export, and fail on stale derived state
        run: ${manager} run xano:check

      # Backstop: the step above covers the lock and any module's own check.
      # This catches anything else the check leaves changed in the working tree.
      - name: Working tree must be clean after the export
        run: git diff --exit-code
`;
}

/** The install, frozen to the manager's lockfile when one is committed. */
function frozenInstall(manager: PackageManager, ignoreWorkspace = false): string {
  switch (manager) {
    case "npm":
      return "if [ -f package-lock.json ]; then npm ci; else npm install; fi";
    case "pnpm":
      return ignoreWorkspace
        ? "if [ -f pnpm-lock.yaml ]; then pnpm install --ignore-workspace --frozen-lockfile; else pnpm install --ignore-workspace; fi"
        : "if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi";
    case "yarn":
      return "if [ -f yarn.lock ]; then yarn install --frozen-lockfile; else yarn install; fi";
    case "bun":
      return "if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile; else bun install; fi";
  }
}

/**
 * The step that puts the manager on the runner, or nothing for npm (setup-node
 * has it). A `packageManager` field pins the version for pnpm and yarn, which
 * corepack and pnpm's setup read; otherwise the version this scaffold ran with.
 */
function managerSetup({ manager, declared, version }: ProjectInstall): string {
  const major = version?.split(".")[0];
  switch (manager) {
    case "npm":
      return "";
    case "pnpm":
      return `
      - uses: pnpm/action-setup@v4
${declared ? "" : `        with:\n          version: '${major ?? "latest"}'\n`}`;
    case "yarn":
      // The runner ships yarn 1, which also defers to a `yarnPath` in .yarnrc.yml.
      return declared ? `\n      - run: corepack enable\n` : "";
    case "bun":
      return `
      - uses: oven-sh/setup-bun@v2
${version === undefined ? "" : `        with:\n          bun-version: '${version}'\n`}`;
  }
}

export function renderEnvExample(): string {
  return `# Point the frontend at a deployed Xano backend. Leave unset to run the UI
# with no backend. When you \`npm run xano:deploy\`, the backend URL is injected
# as window.XANO_HOST at runtime instead — no rebuild needed.
VITE_XANO_HOST=https://your-instance.xano.io
`;
}

export function renderReadme(
  { appName, install }: TemplateVars,
  preset: FrontendPreset,
  choice: ThemeChoice = defaultThemeChoice(),
): string {
  return `# ${appName}

A [Xano SDK](https://www.npmjs.com/package/@xano/sdk) project: a Xano
backend authored in TypeScript under [\`xano/\`](xano/), and a ${preset.label}
frontend under [\`frontend/\`](frontend/) that derives its request paths and
types from the backend defs — so the two can't drift.

## Quick start

\`\`\`bash
${install?.manager ?? "npm"} install${install?.ignoreWorkspace === true ? " --ignore-workspace" : ""}
npm run dev          # run the frontend (no backend needed yet)
\`\`\`

Then author your backend in [\`xano/index.ts\`](xano/index.ts) — start with the
walkthrough in [\`xano/EXAMPLE.md\`](xano/EXAMPLE.md).

## Deploy

\`\`\`bash
npx xanosdk login        # once, to authenticate against your Xano account
npm run xano:deploy     # build the frontend, then ship it with the backend
\`\`\`

- \`npm run xano:deploy:local-engine\` redeploys just the backend to a local engine,
  for a tight loop with no network round-trip. Keep \`npm run dev\` running — the
  deploy points it at the engine. It works on a fresh machine with nothing set: the
  first run downloads the latest engine once per machine and pins its version in
  \`package.json\` (commit that change, so everyone on the project runs the same
  engine). When a newer engine ships, a deploy offers it and never applies it without
  a yes; \`npx xanosdk local-engine update\` moves the pin on purpose, and
  \`npx xanosdk local-engine cache clear\` reclaims the disk space. To try another engine
  without moving the pin, export \`XANOSDK_LOCAL_ENGINE_OVERRIDE\` with a version
  (\`v0.1.5\`) or an engine archive path. It keeps the engine's
  table rows across redeploys (\`--keep-data\`): the first run seeds, later runs merge
  your changes in without re-seeding. Rows survive only in tables and columns that
  keep their names — a rename drops the old one with its rows — and only while the
  engine runs; an engine update or restart starts it empty and the next run seeds
  again. \`npm run xano:deploy:local-engine -- --reset\` gives a clean, re-seeded slate.
- \`npm run xano:deploy:frontend\` rebuilds the frontend and republishes it to the
  environment this project last deployed to — no backend compile or import, so it
  is the quick loop for UI-only changes. \`publish\` does not reach a local engine, so after
  a local-engine deploy run it as \`npm run xano:deploy:frontend -- --to ephemeral\`, or
  have the engine serve a build with \`--static ./frontend/dist\` on the local deploy.
  \`npx xanosdk publish ./frontend/dist --to workspace\` puts the same build in front of
  your real workspace instead.
- \`npm run xano:export\` compiles the backend to \`workspace.json\` (don't commit it).
- \`npm run xano:deploy\` deploys the backend and the built frontend to a live
  **ephemeral** environment and prints its URL. Run it again to refresh the same
  environment; if it expired, a fresh one is created and the new URL is called out.
- \`npx xanosdk status\` says who you are signed in as, which workspace you are bound to, and
  which environment this project last deployed to — its URL, and when it expires. You
  never have to remember the environment's name.
- \`npm run xano:test\` runs the tests the DEPLOYED environment carries — the \`tests\`
  on a query/function/middleware and any \`workflowTest()\`. It compiles nothing, so
  deploy first. A failing suite exits 5, distinct from a crash. \`npx xanosdk deploy
  ./xano/index.ts --test\` does both in one step.

## \`xano.lock\` — commit it

Object identity derives from \`(type, name)\`, so a rename would otherwise change
an object's guid and the engine would **delete and recreate** it rather than
renaming it in place — losing its rows on a record-preserving import.
[\`xano/xano.lock\`](xano/xano.lock) freezes each guid and each API group's
canonical slug, so renames and re-deploys keep the same identities (and the same
public URLs).

Every build writes it — no flag — and it **must be committed**. Ignoring it means
each build mints identities and public URLs that are thrown away and re-invented
next time. If you release to a workspace that already exists, adopt what it
already serves first with \`npx xanosdk lock import <live-bundle.json> --lock=xano/xano.lock\`;
that is also the recovery path once identities have drifted.

\`\`\`bash
npm run xano:check      # CI: fail on ANY build warning (it runs --strict), if the export
                        # would change xano.lock, or if the lock carries an entry no
                        # object matches — writes nothing and needs no secrets, so a
                        # fresh clone runs it as-is
\`\`\`

To rename an object: rename it in code and run \`npm run xano:export\`. Only if it
warns of an orphaned entry, run the \`npx xanosdk lock rename <kind> <old> <new>\` it prints, then
export again. Every \`lock\` subcommand finds \`xano/xano.lock\` from the project entry, as
\`export\` does — \`--entry=<file>\` names another entry, \`--lock=<path>\` the lock itself.

## The one contract

[\`frontend/src/lib/api.ts\`](frontend/src/lib/api.ts) takes request paths from
\`xano/routes.gen.ts\` (\`routePath("GET notes/{id}", { id })\`) and request/response
types from the query defs (\`import type\` + \`InferInput\` / \`InferResponse\`).
Never hand-type a URL or a request body — change a def and the frontend follows.

\`npm run xano:routes\` writes \`xano/routes.gen.ts\` from the defs; \`dev\`, \`build\`
and \`typecheck\` run it first, and \`xano:check\` fails on a missing or stale copy — commit it.
\`init --from\` and \`pull\` write it with the decoded backend.
It is plain data that imports nothing. Importing a def as a value for its
\`getPath()\` would instead pull the backend graph and the SDK runtime into the
browser bundle.

> To spot-check a def from Node (read \`getPath()\`/\`verb\`, log a value), run a real
> file with \`tsx <file.ts>\` **from inside the project root** — not \`tsx -e\`, not
> bare \`node file.ts\`, and not from another directory (they mis-resolve the
> intra-workspace \`.js\` imports and the \`@xano/sdk\` specifier). Or use
> \`npx xanosdk routes xano/index.ts\` to list every endpoint's verb + path.

## The frontend

${preset.readmeFrontendSection(choice.icons)}

${renderReadmeThemingSection(choice)}

## Add-ons

Xano SDK is composable with other \`@xano-sdk/*\` packages:

- **[\`@xano-sdk/auth\`](https://www.npmjs.com/package/@xano-sdk/auth)** — turnkey
  authentication (user/login/signup tables and endpoints). Install it with
  \`npx xanosdk marketplace install @xano-sdk/auth\`, then register it in
  \`xano/index.ts\`. Authentication only — **not** authorization: it has no
  roles, permissions, or route guards, and its tokens carry no role claim.
  Enforce roles off the caller's row with \`@xano/sdk\`: spread
  \`...guard.role(userTable, "admin")\` into the endpoint's stack.
- More \`@xano-sdk/*\` packages register onto the same workspace. This list
  does not update itself — run \`npx xanosdk marketplace list\` for the live
  catalogue, \`npx xanosdk marketplace search <words>\` to narrow it, and
  \`npx xanosdk marketplace details <package>\` to see what an add-on installs and
  how to register it. All three work before you log in.

None of these ship with the scaffold. Install one only when you need it — an
add-on you never register is weight in \`package.json\` for nothing.
`;
}

export function renderXanoIndex({ appName }: TemplateVars): string {
  return `import { workspace } from "@xano/sdk";

/**
 * The ${appName} backend.
 *
 * A workspace is assembled by registering typed objects onto a workspace()
 * instance and default-exporting it. This starter is intentionally empty and
 * already compiles + deploys — add your first table and endpoint below.
 *
 * ── Add your first table + endpoint ─────────────────────────────────────────
 *
 *   import { workspace, table, apiGroup, query, f, input, s, ref, c, expect, resp } from "@xano/sdk";
 *
 *   const notes = table({
 *     name: "notes",
 *     // \`id\` (int PK) + \`created_at\` (epochms) are auto-injected.
 *     schema: {
 *       body: f.text({ required: true }),
 *     },
 *   });
 *
 *   const api = apiGroup({ name: "notes", canonical: "notes" }); // pin the slug
 *
 *   const createNote = query({
 *     name: "create_note",
 *     verb: "POST",
 *     apiGroup: api,
 *     input: { body: input.text({ required: true }) },
 *     // ...build the stack with the s.* statement helpers...
 *     // Assertions ride along with the object they cover; \`npm run xano:test\`
 *     // runs them against whatever you last deployed.
 *     tests: [
 *       {
 *         name: "creates a note",
 *         input: { body: c.text("hello") },
 *         expect: [expect.to_be_defined(resp())],
 *       },
 *     ],
 *   });
 *
 *   export default workspace("${appName}")
 *     .registerTables([notes])
 *     .registerApiGroups([api])
 *     .registerQueries([createNote]);
 *
 * Discover the exact builders and options from the package's own types and its
 * shipped docs — read \`node_modules/@xano/sdk/llms.txt\` first (it ends with a
 * map of the \`llms/*.md\` topic files), then the .d.ts files.
 * See \`xano/EXAMPLE.md\` for the full walkthrough.
 *
 * ── Optional add-ons ─────────────────────────────────────────────────────────
 * Nothing below is installed. Reach for an add-on when you need it, not before.
 *
 * @xano-sdk/auth registers turnkey auth (user/login/signup) onto this same
 * workspace. Install it first (\`npx xanosdk marketplace install @xano-sdk/auth\`), then
 * \`registerAuth(workspace("${appName}"), { canonical: "authn" })\` returns the
 * instance to chain your own .register*() calls onto:
 *
 *   registerAuth(workspace("${appName}"), { canonical: "authn" })
 *     .registerTables([notes])
 *     .registerApiGroups([api])
 *     .registerQueries([createNote]);
 *
 * That is not the whole catalogue. \`npx xanosdk marketplace list\` prints every
 * published add-on and \`npx xanosdk marketplace details <package>\` prints what one
 * installs plus the registration to paste here — no login required.
 */
export default workspace("${appName}");
`;
}

export function renderXanoExampleMd({ appName }: TemplateVars): string {
  return `# Building your ${appName} backend

The backend lives in [\`index.ts\`](index.ts) and is a single default-exported
\`workspace()\`. You grow it by registering typed objects.

## Learn the library from the library

Everything you need is in the package itself:

- \`node_modules/@xano/sdk/llms.txt\` — the router: the mental model, the deploy contract, every gotcha, and control flow. Read it in full first; it ends with a list of topic files and the condition for opening each.
- \`node_modules/@xano/sdk/llms/*.md\` — one file per surface. Open the one or two whose condition matches the task; skip the rest.
- The published TypeScript types and JSDoc (\`node_modules/@xano/sdk/**/*.d.ts\`).
- \`node_modules/@xano/sdk/manifest.json\` — the exhaustive reference; grep or \`jq\` the one entry you need rather than reading it whole.

Author against those signatures — don't invent an API that isn't there.

## The shape

\`\`\`
xano/
├── index.ts          default export: the workspace registering everything below
├── tables/<name>.ts  a table (name, typed schema, indexes)
├── api/<group>.ts    an API group; pin its canonical slug so paths are stable
└── api/<endpoint>.ts a query: name, verb, apiGroup, typed input, a stack, a response
\`\`\`

## Steps

1. **Define a table** under \`tables/\` with \`table({ name, schema: { ... } })\`.
   \`id\` and \`created_at\` are auto-injected.
2. **Define an API group** with \`apiGroup({ name, canonical })\`. Pinning the
   canonical slug keeps the public path stable and lets \`npm run xano:routes\`
   resolve it without a lock file.
3. **Define endpoints** with \`query({ name, verb, apiGroup, input, ... })\`, building
   the logic from the \`s.*\` statement helpers and the expression/column/input/
   reference helpers.
4. **Register everything** in \`index.ts\`:
   \`\`\`ts
   export default workspace("${appName}")
     .registerTables([...])
     .registerApiGroups([...])
     .registerQueries([...]);
   \`\`\`
5. **Assert it works** — add a \`tests: [...]\` entry to a query or function
   (named inputs plus \`expect.*\` assertions on its response), or a
   \`workflowTest({ name, stack })\` when the behavior spans several objects.
   They live beside the code they cover and ship with it. See "Testing" below.
6. **Compile** with \`npm run xano:export\`, and **deploy** with
   \`npm run xano:deploy\` (after \`npx xanosdk login\`). The first of either writes
   \`xano/xano.lock\` — **commit it**. It pins every object's identity, so a later
   rename renames the object instead of deleting and recreating it. See
   "\`xano.lock\` — commit it" in the project README.

## Testing

Two kinds of test are authored in \`xano/\` alongside the objects they cover, and
both run against a DEPLOYED environment:

- **Unit test** — \`tests: [...]\` on a \`query\`, \`defineFunction\`, or
  \`middleware\`. Each entry is a named set of inputs run against that object, with
  \`expect.*\` assertions on its response. A statement's \`mock\` (keyed by test
  NAME) makes one step return a value instead of doing its work, but only while
  that test runs.
- **Workflow test** — \`workflowTest({ name, stack })\`, a standalone object whose
  stack calls others (\`s.function.call\`, \`s.api.call\`) and asserts with
  \`s.expect.*\`. Use it for behavior that spans objects.

\`expect.*\` and \`s.expect.*\` are different builders — an assertion record versus
a workflow-test statement — and are not interchangeable.

\`\`\`bash
npm run xano:deploy    # tests run against what is deployed, so deploy first
npm run xano:test      # runs both kinds; exits 5 if any fail
\`\`\`

\`npx xanosdk deploy ./xano/index.ts --test\` does both in one step, and
\`npx xanosdk test list\` shows what a deployed environment carries without running
anything. Read \`node_modules/@xano/sdk/llms/tests.md\` before authoring either
kind.

### Event-driven objects

A scheduled \`task\`, an \`mcpServer\`, and every trigger **fire normally on an
ephemeral** — where \`deploy\` sends them — so test them by deploying and letting
them run.

## Wire the frontend

In [\`../frontend/src/lib/api.ts\`](../frontend/src/lib/api.ts), never hand-type a
URL or a request body:

- **Paths and verbs** come from \`xano/routes.gen.ts\`:
  \`routePath("POST create_note")\`, \`ROUTES["POST create_note"].verb\` (a verb+name two api
  groups share is keyed \`"<group>:<VERB> <name>"\`). Run
  \`npm run xano:routes\` after adding or renaming an endpoint (\`dev\`, \`build\` and
  \`typecheck\` also run it) and commit the file.
- **Shapes** come from the defs with \`import type\` — \`InferInput\`/\`InferResponse\`
  erase to nothing.
- Never import a def as a value in the frontend. Its \`s.*\`/\`c.*\` stack calls run
  at module load, so one import for its \`getPath()\` pulls the backend graph it
  references and the SDK runtime into the bundle.
`;
}

/** Where a pulled tree came from, for the marker and the README. */
export interface CodegenOrigin {
  /** Which command form produced the tree. */
  readonly source: "workspace" | "ephemeral" | "local-engine" | "tenant" | "release" | "file";
  /** The workspace id, backend or release name, or bundle path — whatever identifies the source. */
  readonly origin: string;
  /** The workspace branch read, when one was named (`--branch`). */
  readonly branch?: string;
}

/** A human phrase for an origin, used in both the README and the CLI summary. */
export function describeOrigin(o: CodegenOrigin): string {
  switch (o.source) {
    case "workspace":
      return `workspace ${o.origin}`;
    case "ephemeral":
      return `ephemeral "${o.origin}"`;
    case "local-engine":
      return `local engine "${o.origin}"`;
    case "tenant":
      return `tenant "${o.origin}"`;
    case "release":
      return `release "${o.origin}"`;
    case "file":
      return `the bundle at ${o.origin}`;
  }
}

/**
 * {@link describeOrigin} for a file the project COMMITS (its README, the landing
 * page): a bundle is named by its file name, not the absolute path it happened
 * to sit at on the machine that ran `init --from`.
 */
export function describeCommittedOrigin(o: CodegenOrigin): string {
  if (o.source !== "file") return describeOrigin(o);
  const name = o.origin.split(/[\\/]/).pop() || o.origin;
  return `the bundle ${name}`;
}

/**
 * The provenance marker a pulled project carries.
 *
 * Two jobs: it records where the tree came from, and its presence is what lets a
 * re-run refresh `xano/` without `--force` (see `scaffold.ts`). It lives inside
 * `xano/` so the delete-and-rewrite branch is self-cleaning — no marker is ever
 * left pointing at a directory that no longer matches it.
 */
export function renderCodegenMarker(
  { sdkVersion }: TemplateVars,
  origin: CodegenOrigin,
  generatedAt: string,
  report?: unknown,
  /**
   * The `xano/`-relative files this decode wrote — the record a re-run removes
   * by, as `generate --force` does: what the previous decode wrote and this one
   * does not is removed, and a file no decode wrote is kept.
   */
  files?: readonly { readonly path: string; readonly content: string }[],
): string {
  // Head, report, then the file record — the order every decode writes
  // (`decodeMarkerHead`), so the report does not move when a pull rewrites it.
  const head = {
    source: origin.source,
    origin: origin.origin,
    sdkVersion,
    generatedAt,
    note: "Written by `xanosdk init --from`. Its presence lets a re-run refresh xano/ in place.",
    // The findings, so parity is trackable release over release and gateable
    // in CI without scraping stderr. Omitted rather than written empty when
    // the caller has none to record.
    ...(report === undefined ? {} : { report }),
  };
  // With each file's digest, so a re-run tells a file you edited from one
  // only the source changed.
  return JSON.stringify(files === undefined ? head : decodeMarkerWith(head, files), null, 2) + "\n";
}

/**
 * The root README for a pulled project.
 *
 * `init`'s README addresses someone about to author a backend; this one
 * addresses someone who already has one and just pulled it. The warnings are
 * unconditional and rescoped: it is **`xano/`** a refresh rewrites, not the
 * project around it.
 */
export function renderCodegenReadme(
  { appName }: TemplateVars,
  origin: CodegenOrigin,
  envNames: readonly string[],
  preset: FrontendPreset,
): string {
  const secrets =
    envNames.length === 0
      ? ""
      : `
## Fill in the backend env values

The pull carried ${envNames.length} workspace env var${envNames.length === 1 ? "" : "s"} —
${envNames.map((n) => `\`${n}\``).join(", ")} — as NAMES only. The values stayed in the
workspace; no committed file holds a secret.

\`\`\`bash
cp xano/.env.example xano/.env    # then edit in the values
npx xanosdk env pull               # or fetch them from a running backend (confirms before replacing)
\`\`\`

Every command that compiles a bundle reads \`xano/.env\` with no flag. It and
\`xano/.secrets.json\` (documentation tokens) are gitignored and survive a \`npx xanosdk pull\` —
the two files under \`xano/\` that are not committed. The source beside them is meant to
be reviewed, so never ignore \`xano/\` wholesale.

A deploy REPLACES the backend's env set, so a declared name with no value refuses the
deploy rather than clearing the live value. In CI, which does not have this file, mount
one and pass \`--backend-env-file <path>\`, or supply names with \`--env-var KEY=VALUE\`.

\`workspace.json\` is a different matter: a compiled bundle carries these values in
cleartext, which is why it is gitignored too.
`;

  return `# ${appName}

A [Xano SDK](https://www.npmjs.com/package/@xano/sdk) project pulled from
${describeCommittedOrigin(origin)}. The Xano backend lives in [\`xano/\`](xano/) as readable
TypeScript; the ${preset.label} frontend under [\`frontend/\`](frontend/) is a starter —
the pull carries a backend, not a UI.

## Deploy it

\`\`\`bash
npx xanosdk login        # once, to authenticate against your Xano account
npm run xano:deploy     # typecheck, build the frontend, ship both
\`\`\`

## Read this before deploying

- **\`xano/\` is your source now** — edit it and commit it. \`npx xanosdk pull\` (or re-running
  \`npx xanosdk init --from\`) refreshes it from a backend: it lists what will change and asks
  first, keeps files you added, and overwrites the files it decodes — commit first.
- **\`npx xanosdk deploy\` is a full replace** of an **ephemeral** environment or a local engine
  (\`npm run xano:deploy\`), unless \`--keep-data\` merges into the one an earlier deploy
  filled. A real workspace is reached with \`npx xanosdk promote <release>\` or
  \`npx xanosdk deploy --to workspace\`, which merge and leave table rows alone.
- **This is schema only.** Table rows are not carried, and neither are payload sections
  this SDK models no kind for. A deploy recreates the structure, not the data.

[\`xano/README.md\`](xano/README.md) is the authoritative record of what did and did not
translate cleanly on this pull. Read it before trusting the tree.
${secrets}
## Working on it

\`\`\`bash
npm run dev            # run the starter frontend
npm run typecheck      # the whole project, both halves
npm run xano:export    # compile the backend to workspace.json (don't commit it)
npm run xano:routes    # regenerate xano/routes.gen.ts, the frontend's paths
\`\`\`

[\`frontend/src/lib/api.ts\`](frontend/src/lib/api.ts) shows the one contract: paths
from \`routePath()\` in \`xano/routes.gen.ts\`, types from the query defs in \`xano/\`.
`;
}

/**
 * The README's `## Theming` section.
 *
 * Framework-agnostic, and therefore here rather than in a preset: both UI kits
 * read the same token names out of the same stylesheet, so "how do I rebrand
 * this" has one answer regardless of what renders it.
 *
 * It tells the reader which theme they picked, because six months later the
 * stylesheet is 60 opaque oklch values and nothing else in the project records
 * that they chose `Zinc Blue` — which is exactly what they need to know to ask
 * for something adjacent to it.
 */
function renderReadmeThemingSection(choice: ThemeChoice): string {
  const { theme, dark } = choice;
  const darkNote = {
    system: `Dark mode follows the OS. An inline script in the HTML entry sets
\`class="dark"\` on \`<html>\` before first paint (so the page never flashes light
first), and the \`.dark\` block in the stylesheet supplies the palette. To let
people override it, add a control that toggles that class — or scaffold your
next project with \`--dark toggle\`, which ships one.`,
    toggle: `Dark mode follows the OS until the user says otherwise. The pieces:
an inline script in the HTML entry applies the mode before first paint,
[\`frontend/src/lib/theme.ts\`](frontend/src/lib/theme.ts) holds and persists it,
and the mode toggle on the landing page cycles system → light → dark.`,
    off: `This project was scaffolded with \`--dark off\`, so nothing switches
themes. The \`.dark\` block in the stylesheet is still there and still complete —
add \`class="dark"\` to \`<html>\` to see it, and wire that to a control (or the OS
setting) to turn it on for real.`,
  }[dark];

  return `## Theming

Scaffolded with the **${theme.label}** theme. Every color in the app comes from
the semantic tokens at the top of
[\`frontend/src/index.css\`](frontend/src/index.css) — \`--primary\`,
\`--muted-foreground\`, \`--border\`, the \`--chart-*\` ramp, the \`--sidebar-*\` set —
and every shadcn component reads those names, so editing one value rebrands
everything that uses it. Style with the token classes (\`bg-primary\`,
\`text-muted-foreground\`) rather than raw palette classes like \`bg-gray-100\`, or
the theme stops being one.

Tailwind v4 has no \`tailwind.config.js\`; that stylesheet *is* the config.

To swap the whole palette later:

\`\`\`bash
npx shadcn@latest add https://ui.shadcn.com/r/themes/stone.json   # or any registry theme
\`\`\`

${darkNote}`;
}

/**
 * Where every landing page's "learn more" button points. One constant so the
 * two copy values below cannot drift on it.
 */
const UI_DOCS_CTA = {
  label: "Browse UI components",
  href: "https://ui.shadcn.com/docs/components",
} as const;

/**
 * The `init` landing page's copy — addressed to someone about to author a
 * backend. Content, not markup: each frontend preset renders it into its own
 * component language, so adding a framework does not add a landing page to
 * keep in sync. See {@link LandingContent}.
 */
export function initLanding({ appName }: TemplateVars): LandingContent {
  return {
    title: appName,
    lead: [
      { text: "Your Xano SDK project is ready. The backend lives in " },
      { code: "xano/" },
      { text: " and this frontend in " },
      { code: "frontend/" },
      { text: "." },
    ],
    steps: [
      [
        { text: "Author your first table + endpoint in " },
        { code: "xano/index.ts" },
        { text: " (see " },
        { code: "xano/EXAMPLE.md" },
        { text: ")." },
      ],
      [{ text: "Wire it into the UI from " }, { code: "frontend/src/lib/api.ts" }, { text: "." }],
      [{ text: "Ship it: " }, { code: "npm run xano:deploy" }, { text: "." }],
    ],
    cta: UI_DOCS_CTA,
  };
}

/**
 * The `init --from` landing page's copy — addressed to someone who already has a
 * backend and just pulled it. See {@link initLanding}.
 */
export function codegenLanding({ appName }: TemplateVars, origin: CodegenOrigin): LandingContent {
  return {
    title: appName,
    lead: [
      { text: `This project was pulled from ${describeCommittedOrigin(origin)}. The backend lives in ` },
      { code: "xano/" },
      { text: " as readable TypeScript; this frontend is a starter." },
    ],
    steps: [
      [
        { text: "Read " },
        { code: "xano/README.md" },
        { text: " — what did and did not translate cleanly on the pull." },
      ],
      [
        { text: "List the endpoints: " },
        { code: "npx xanosdk routes xano/index.ts" },
        { text: ", then wire them up in " },
        { code: "frontend/src/lib/api.ts" },
        { text: "." },
      ],
      [
        { text: "Ship it: " },
        { code: "npm run xano:deploy" },
        { text: " (a full replace of an ephemeral env)." },
      ],
    ],
    cta: UI_DOCS_CTA,
  };
}

/**
 * The frontend stylesheet: Tailwind v4 plus the shadcn/ui theme layer.
 *
 * shadcn/ui components are Tailwind classes over a fixed set of semantic color
 * tokens (`bg-primary`, `text-muted-foreground`, `border-input`, …). Those
 * tokens are declared here as CSS custom properties — light on `:root`, dark
 * under `.dark` — and mapped into Tailwind's theme with `@theme inline`, which
 * is how v4 replaces the v3 `tailwind.config.js`. Every component the shadcn CLI
 * adds later resolves against this same block, so it is the one file to edit
 * when rebranding.
 *
 * The VALUES come from the {@link ThemeChoice} resolved at scaffold time (see
 * `theme-presets.ts`); the structure around them does not vary. Two details in
 * that structure are load-bearing:
 *
 * - The full token set is emitted, `chart-1..5` and `sidebar-*` included, even
 *   though nothing in a fresh scaffold reads them. `chart` and `sidebar` are
 *   among the first components anyone adds, and a component whose colors
 *   resolve to nothing renders invisibly with no error anywhere.
 * - `--color-*` aliases are emitted for colors only. `--radius` is a length,
 *   and aliasing it into the color scale would put a non-color in Tailwind's
 *   color autocomplete.
 */
export function renderIndexCss(choice: ThemeChoice = defaultThemeChoice()): string {
  const { theme } = choice;
  const colorMap = colorTokens(theme.light)
    .map((token) => `  --color-${token}: var(--${token});`)
    .join("\n");
  const block = (vars: Readonly<Record<string, string>>): string =>
    orderedTokens(vars)
      .map(([name, value]) => `  --${name}: ${value};`)
      .join("\n");
  // Font faces load BEFORE Tailwind. CSS requires every @import at the top of
  // the sheet, and putting the faces first means the browser starts fetching
  // them while the (much larger) utility layer is still parsing.
  const faces = fontImports(choice.fonts);
  const fontVars = fontThemeVars(choice.fonts)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  // A display face on h1–h6 has to be bound somewhere. Tailwind has no heading
  // slot, and leaving it to a `font-heading` class on every heading means the
  // first one an assistant writes without it is off-brand and nothing says so.
  const headingRule =
    choice.fonts?.heading === undefined
      ? ""
      : `
  h1,
  h2,
  h3,
  h4,
  h5,
  h6 {
    font-family: var(--font-heading);
  }`;
  return `${faces.length === 0 ? "" : faces.join("\n") + "\n"}@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

/* Map the tokens below into Tailwind's theme so \`bg-primary\` and friends
   resolve. Tailwind v4 does this in CSS; there is no tailwind.config.js. */
@theme inline {
${colorMap}
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);${fontVars === "" ? "" : `\n${fontVars}`}
}

/* Theme: ${theme.label}. Rebrand here — these are the only colors the
   components know about. Swap the whole palette for another shadcn theme with
   \`npx shadcn@latest add <registry-theme-url>\`, or scaffold a different one
   next time with \`npx @xano/sdk init --theme <base>-<accent>\`. */
:root {
${block(theme.light)}
}

${darkBlockComment(choice.dark)}
.dark {
${block(theme.dark)}
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }${headingRule}
}
`;
}

/** The comment above `.dark`, which describes whatever actually switches it on. */
function darkBlockComment(dark: DarkMode): string {
  switch (dark) {
    case "system":
      return `/* Applied by the inline script in index.html, which follows the OS setting.
   Add a control that toggles this class to let the user override it. */`;
    case "toggle":
      return `/* Applied by frontend/src/lib/theme.ts — the OS setting by default, and the
   user's choice once they use the mode toggle. */`;
    case "off":
      return `/* Applied by adding \`class="dark"\` to <html> — wire that to a toggle if you
   want one; this scaffold was created with --dark off, so nothing does yet. */`;
  }
}

/**
 * The no-flash theme script, inlined into `<head>` before any stylesheet.
 *
 * It has to be inline and synchronous. A module that runs after first paint
 * cannot prevent the flash of the wrong theme, because the page is already on
 * screen in light mode by then — the one visible bug a dark-mode implementation
 * is judged on. That is also why it is duplicated into the framework's HTML
 * entry rather than imported: the import itself would be the delay.
 *
 * `off` renders nothing at all, keeping that scaffold byte-identical to one
 * with no dark support.
 */
export function renderThemeScript(dark: DarkMode): string {
  if (dark === "off") return "";
  const resolve =
    dark === "toggle"
      ? `var stored = localStorage.getItem("theme");
          var dark = stored === "dark" || (stored !== "light" && media.matches);`
      : `var dark = media.matches;`;
  return `    <script>
      // Sets the \`dark\` class before first paint, so the page never flashes
      // light before switching. Keep this inline and above the stylesheet.
      (function () {
        try {
          var media = window.matchMedia("(prefers-color-scheme: dark)");
          ${resolve}
          document.documentElement.classList.toggle("dark", dark);
        } catch (e) {}
      })();
    </script>
`;
}

/**
 * `frontend/src/lib/theme.ts` — the mode store behind the toggle control.
 *
 * Framework-agnostic on purpose: it is plain DOM and `localStorage`, so React's
 * and Svelte's toggles are each a dozen lines of markup over the same three
 * functions instead of two independent implementations that drift.
 *
 * Only written for `--dark toggle`; `system` needs no state beyond the inline
 * script, and storing a preference nothing can change would be dead code.
 */
export function renderThemeModule(): string {
  return `/**
 * Color mode, persisted. The inline script in index.html applies the stored
 * value before first paint; this module is what changes it afterwards.
 *
 * "system" means no stored preference — the OS decides, and keeps deciding if
 * the user changes it while the page is open.
 */
export type Mode = "light" | "dark" | "system";

const KEY = "theme";

const prefersDark = () =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;

/** The stored preference, or "system" when there is none. */
export function getMode(): Mode {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** Whether \`mode\` renders dark right now. */
export function isDark(mode: Mode): boolean {
  return mode === "dark" || (mode === "system" && prefersDark());
}

/** Persist a mode and apply it. "system" clears the stored override. */
export function setMode(mode: Mode): void {
  if (mode === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, mode);
  document.documentElement.classList.toggle("dark", isDark(mode));
}

/**
 * Re-apply on OS changes, and on changes made in another tab. Returns an
 * unsubscribe function — call it from your framework's cleanup hook.
 *
 * The OS listener re-reads the mode rather than closing over it, so it stays
 * correct after the user picks an explicit light/dark and then goes back to
 * system.
 */
export function watchMode(onChange: (mode: Mode) => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    const mode = getMode();
    document.documentElement.classList.toggle("dark", isDark(mode));
    onChange(mode);
  };
  media.addEventListener("change", apply);
  window.addEventListener("storage", apply);
  return () => {
    media.removeEventListener("change", apply);
    window.removeEventListener("storage", apply);
  };
}
`;
}

/**
 * `cn()` — the class merger every shadcn/ui component imports. `clsx` resolves
 * conditionals; `tailwind-merge` then drops earlier Tailwind classes that a
 * later one overrides, so a caller's `className` always wins over a component's
 * defaults instead of colliding with them.
 */
export function renderCnUtil(extra = ""): string {
  return `import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
${extra}`;
}

export function renderApiTs(): string {
  return `// The one contract: endpoint paths come from the generated route manifest, and
// request/response *types* from your xanosdk query defs. Never hand-type a URL
// or a request body: change a def and everything here follows.
//
// Keep the backend out of the browser bundle:
//   • Paths and verbs: \`routePath()\` / \`ROUTES\` from xano/routes.gen.ts, plain data
//     generated from the defs (\`npm run xano:routes\`; dev, build and typecheck
//     regenerate it). Never import a def as a VALUE for its getPath()/verb:
//     its s.*/c.* factory calls run at module load, so one import pulls in the
//     backend graph it references and the SDK runtime that builds it.
//   • Shapes: \`import type\` only. InferInput/InferResponse erase to nothing.
//
// Nothing here imports the manifest yet — an add-on's endpoints may already be
// in it. Wire an endpoint (one in xano/, or an add-on's) like:
//
//   import type { InferInput, InferResponse } from "@xano/sdk";
//   import type { createNoteQuery } from "../../../xano/api/create-note.js";
//   import { ROUTES, routePath } from "../../../xano/routes.gen.js";
//
//   export type CreateNoteBody = InferInput<typeof createNoteQuery>;
//   export type Note = InferResponse<typeof createNoteQuery>;
//
//   export async function createNote(body: CreateNoteBody): Promise<Note> {
//     const res = await fetch(XANO_HOST + routePath("POST create_note"), {
//       method: ROUTES["POST create_note"].verb,
//       headers: { "content-type": "application/json" },
//       body: JSON.stringify(body),
//     });
//     if (!res.ok) throw new Error(await res.text());
//     return res.json();
//   }
//
// Keys are "<VERB> <query name>"; path params are passed by name, e.g.
// routePath("GET notes/{id}", { id }). A renamed endpoint is a compile error.

// Types the global the deploy injects, for every file in the project: the
// documented \`window.XANO_HOST\` reads compile anywhere. \`undefined\` in dev.
declare global {
  interface Window {
    XANO_HOST?: string;
  }
}

/**
 * The deployed Xano backend's base URL. Injected as \`window.XANO_HOST\` by
 * \`npx xanosdk deploy <entry> --static <dir>\`, or read from \`VITE_XANO_HOST\` in dev.
 * Empty string when neither is set (the UI runs with no backend).
 */
export const XANO_HOST: string =
  (typeof window !== "undefined" && window.XANO_HOST) ||
  import.meta.env.VITE_XANO_HOST ||
  "";
`;
}
