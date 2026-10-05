/**
 * The whole `routes.gen.ts`, as every writer of it produces it: the core
 * sections from the route plan, then each toolchain module's section.
 *
 * ONE function for `routes --emit`, the refresh `marketplace remove` runs,
 * plain `init`, and the decode paths (`pull`, `generate`), so that for the same
 * workspace and the same installed modules they write the same bytes (R6) and
 * `routes --emit --strict` never flips depending on which of them wrote last.
 * Only how each one FINDS its modules differs, and that stays with the caller.
 *
 * Synchronous and silent: the decode paths place the file synchronously, and
 * what a module failure means (a warning, or a refusal under `--strict`) is the
 * caller's to decide — see {@link reportModuleFailures}.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { renderPlannedManifest, renderRouteManifest, ROUTES_MANIFEST_BASENAME, type RoutePlan } from "./routes-manifest.js";
import { composeRoutesManifest, parseModuleSections, type ModuleSection } from "./routes-manifest-modules.js";
import { fireRoutesManifest } from "./toolchain-hooks.js";
import type { LoadedPlugin, SkippedPlugin } from "./toolchain-modules.js";
import { warn } from "./ui.js";

/** The toolchain modules a writer found, and the file it is about to replace. */
export interface ManifestModules {
  /** The modules discovery imported. Each one's `routesManifest`, if any, is fired. */
  readonly loaded: readonly LoadedPlugin[];
  /** The modules discovery could not load: their previous block, if any, is carried forward. */
  readonly skipped: readonly SkippedPlugin[];
  /** The `routes.gen.ts` being replaced, if there is one — where a failed module's block is read back from. */
  readonly previous: string | undefined;
  /** The running SDK's version, handed to every hook. */
  readonly sdkVersion: string;
}

/** A module that contributed no fresh section this run. */
export interface ModuleFailure {
  readonly pkg: string;
  readonly why: string;
  /** Whether its block from the previous file was carried forward. */
  readonly carried: boolean;
}

/** The file's text, and the modules whose section had to be carried or left out. */
export interface ManifestFile {
  readonly source: string;
  readonly failed: readonly ModuleFailure[];
}

/**
 * What a decode (`pull`, `generate`) places the manifest with: the modules the
 * project at `projectDir` has installed, and the manifest at `manifestPath` it
 * replaces. Call it BEFORE any entry is loaded (see `discoverToolchainPlugins`).
 * Not frozen: a decode writes, and a module that cannot load keeps its block —
 * a module outside its SDK peer range included, rather than aborting the decode.
 */
export async function discoverManifestModules(
  projectDir: string,
  manifestPath: string,
  sdkVersion: string,
): Promise<ManifestModules> {
  const { discoverToolchainPlugins } = await import("./toolchain-modules.js");
  const { loaded, skipped } = await discoverToolchainPlugins(projectDir, { frozen: false, peerSkew: "skip" });
  return {
    loaded,
    skipped,
    // Only when a module could fail or be skipped: with none, nothing is
    // carried forward and `renderManifestFile` never consults it. Only a file:
    // a directory in its place is the write's to report (`generate` says the
    // tree is whole without it), not this read's to fail on.
    previous:
      loaded.length + skipped.length > 0 && existsSync(manifestPath) && statSync(manifestPath).isFile()
        ? readFileSync(manifestPath, "utf8")
        : undefined,
    sdkVersion,
  };
}

/**
 * Render the manifest a plan describes, with every module's section composed in
 * (KTD7): the core sections always fresh; a module whose hook failed, or that
 * could not be loaded at all, keeps its block from `modules.previous` verbatim,
 * and contributes nothing when it had none. `undefined` when there is no file
 * to write (see {@link renderPlannedManifest}); `orEmpty` writes the empty
 * manifest instead, for a writer replacing a file whose routes are all gone.
 *
 * Throws a `RouteManifestError` for a plan the manifest cannot carry, and when
 * a failed module's previous block cannot be read back (a hand-edited block is
 * not guessed at).
 */
export function renderManifestFile(
  plan: RoutePlan,
  modules: ManifestModules | undefined,
  opts: { readonly entry?: string; readonly orEmpty?: boolean } = {},
): ManifestFile | undefined {
  const core =
    renderPlannedManifest(plan, opts.entry) ??
    (opts.orEmpty === true && plan.resolved.length === 0 && plan.servers.length === 0 ? renderRouteManifest([]) : undefined);
  if (core === undefined) return undefined;
  if (modules === undefined) return { source: core, failed: [] };

  const sections: ModuleSection[] = [];
  const failures: Array<{ pkg: string; why: string; hook: boolean }> = [];
  for (const result of fireRoutesManifest(modules.loaded, { inputs: plan.inputs, sdkVersion: modules.sdkVersion })) {
    if (result.kind === "section") sections.push({ pkg: result.pkg, version: result.version, section: result.section });
    else failures.push({ pkg: result.pkg, why: result.why, hook: true });
  }
  for (const { pkg, why } of modules.skipped) failures.push({ pkg, why, hook: false });

  // Only the failed modules' blocks are read back: a block nobody needs to
  // carry is never parsed, so a hand edit or a merge conflict in it cannot fail
  // a run it does not affect.
  const previous =
    failures.length > 0 && modules.previous !== undefined
      ? new Map(
          parseModuleSections(modules.previous, new Set(failures.map((f) => f.pkg))).map((s) => [s.pkg, s] as const),
        )
      : new Map<string, ModuleSection>();
  const failed: ModuleFailure[] = [];
  for (const { pkg, why, hook } of failures) {
    const carried = previous.get(pkg);
    if (carried !== undefined) sections.push(carried);
    // A module that could not load and owns no block is discovery's to report,
    // and it already has; repeating it here would say nothing about this file.
    if (hook || carried !== undefined) failed.push({ pkg, why, carried: carried !== undefined });
  }
  return { source: composeRoutesManifest(core, sections), failed };
}

/**
 * Say what {@link renderManifestFile} could not refresh. On a writing run, a
 * warning per file naming each module and whether its previous block was kept;
 * on a verifying one (`--strict`), a refusal: a check whose module did not run
 * must not read as a check that passed.
 */
export function reportModuleFailures(
  failed: readonly ModuleFailure[],
  file: string,
  strict = false,
): void {
  if (failed.length === 0) return;
  const lines = failed.map(
    (f) =>
      `${f.pkg} — ${f.why} (${f.carried ? "its previous block was kept as it was" : `it has no block in ${ROUTES_MANIFEST_BASENAME} yet, so none was written`})`,
  );
  if (strict) {
    throw new Error(
      `--strict: ${file} cannot be checked: ${failed.length === 1 ? "a toolchain module's section" : `${failed.length} toolchain modules' sections`} ` +
        `could not be generated, and a section that was not generated was not checked:\n` +
        lines.map((l) => `  ${l}`).join("\n") +
        `\n\nRun \`xanosdk marketplace reinstall <package>\` to repair a module that should still be here, or ` +
        `set \`"<package>": { "enabled": false }\` in package.json's "xanosdk" block to turn it off.`,
    );
  }
  warn(
    `${file}: ${failed.length === 1 ? "a toolchain module" : `${failed.length} toolchain modules`} could not generate ` +
      `${failed.length === 1 ? "its section" : "their sections"}; the rest of the file was refreshed.`,
    "routes.module-failed",
    lines,
  );
}
