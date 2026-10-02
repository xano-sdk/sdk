/**
 * What a marketplace NAME means — the one resolver behind `marketplace install`,
 * `reinstall`, `remove` and `init --marketplace`.
 *
 * `install auth` once handed `auth` to npm, which installed the unrelated npm
 * package of that name and reported success, while `details auth` answered for
 * `@xano-sdk/auth`: the same argument meant two different packages on two verbs.
 * Every verb that takes a module name now asks this file, so the name means the
 * same package everywhere — and `init --marketplace auth` cannot install npm's
 * `auth` while `marketplace install auth` refuses it.
 */
import { EXIT_SOURCE_UNRESOLVABLE } from "./source-selector.js";
import {
  CatalogueUnreachableError,
  fetchCatalogue,
  fetchModule,
  isCatalogueOutage,
  ModuleNotFoundError,
  type CatalogueModule,
} from "./marketplace-catalogue.js";
import { CliError } from "./errors.js";
import type { ParsedArgs } from "./cli.js";
import { suggest } from "../util/suggest.js";
import { localPackageName, packageNameOf } from "./module-manifest.js";
import { declaredDependencies, readProjectManifest, readToolchainBlock } from "./project-config.js";
import { info } from "./ui.js";

/** The scope the marketplace's own modules publish under. */
export const FIRST_PARTY_SCOPE = "@xano-sdk/";

/**
 * Whether a specifier names a package on disk or at a URL rather than a name in
 * the registry: `file:`, a git or tarball URL, a path. Those are a module
 * author's own build, installed on purpose, and the catalogue has nothing to say
 * about them.
 */
export function isLocalSpecifier(spec: string): boolean {
  return (
    /^(file|git|git\+[a-z]+|https?|link|workspace):/i.test(spec) ||
    /^[./~]/.test(spec) ||
    /\.(tgz|tar\.gz)$/i.test(spec)
  );
}

/**
 * A name the catalogue does not list: the not-found failure, exit 8 like
 * `marketplace details <missing>`. Not a usage error — the name was typed as
 * intended and the catalogue said no.
 */
export class MarketplaceModuleNotFoundError extends Error {
  override readonly name = "MarketplaceModuleNotFoundError";
  readonly exitCode = EXIT_SOURCE_UNRESOLVABLE;
  /** The near name to type — the failure document's `suggestion` (the first of {@link suggestions}). */
  readonly suggestion: string | undefined;
  /** Every near name, one per missed name, when there is more than one. */
  readonly suggestions: string[] | undefined;
  /**
   * Of a list lookup ({@link resolveMarketplaceSpecs}): every name's package,
   * each missed one swapped for the listed module it is one slip from — set
   * only when every miss has one. What a caller spells its corrected
   * commands from.
   */
  corrected: string[] | undefined;

  constructor(message: string, near: readonly string[] = []) {
    super(message);
    this.suggestion = near[0];
    this.suggestions = near.length > 1 ? [...near] : undefined;
  }
}

/** A miss's sentence, and the near names it offers. */
interface MissHint {
  text: string;
  near: string[];
  /** The near spellings in full: the name missed, the spelling, the package it means. */
  modules: NearModule[];
}

function searchHint(name: string): string {
  const query = name.startsWith(FIRST_PARTY_SCOPE) ? name.slice(FIRST_PARTY_SCOPE.length) : name;
  return `Run \`xanosdk marketplace search ${query}\` to find the module's real name, or \`xanosdk marketplace list\` for every one.`;
}

/**
 * The way out of a miss: the listed module each name is one slip from, when
 * one is (`authh` → `auth`), else {@link searchHint}. A search for the typo
 * itself matches nothing — the remedy the miss printed alone (E2E pass 26).
 * The catalogue is read once for all of them; when it cannot be read, the
 * search hint stands, since the miss itself was already answered.
 */
async function missHint(names: readonly string[]): Promise<MissHint> {
  let byName: Map<string, string>;
  try {
    byName = spellingsOf((await fetchCatalogue()).flatMap((row) => (row.npm_package === undefined ? [] : [row.npm_package])));
  } catch {
    return { text: searchHint(names[0]!), near: [], modules: [] };
  }
  const near = nearNames(names, byName);
  if (near.length === 0) return { text: searchHint(names[0]!), near: [], modules: [] };
  return {
    text: `Did you mean ${saidNear(near, names.length)}? \`xanosdk marketplace list\` lists every module.`,
    near: near.map((n) => n.hit),
    modules: near,
  };
}

/** A not-found failure: `head`, then the miss's way out, with its near names as `suggestion(s)`. */
async function notFound(head: string, names: readonly string[]): Promise<MarketplaceModuleNotFoundError> {
  return (await notFoundWith(head, names)).err;
}

async function notFoundWith(
  head: string,
  names: readonly string[],
): Promise<{ err: MarketplaceModuleNotFoundError; modules: NearModule[] }> {
  const hint = await missHint(names);
  return { err: new MarketplaceModuleNotFoundError(`${head} ${hint.text}`, hint.near), modules: hint.modules };
}

/** Every spelling that names one of `packages` — the package, and an `@xano-sdk/` one's slug — to the package. */
function spellingsOf(packages: readonly string[]): Map<string, string> {
  const byName = new Map<string, string>();
  for (const pkg of packages) {
    byName.set(pkg, pkg);
    if (pkg.startsWith(FIRST_PARTY_SCOPE)) byName.set(pkg.slice(FIRST_PARTY_SCOPE.length), pkg);
  }
  return byName;
}

/**
 * The one of `packages` that `name` is a slip from, spelled as `name` was
 * (`authh` → `auth`, for `@xano-sdk/auth`) — `undefined` when none is close.
 * For a verb whose candidates are not the catalogue: `remove` can only act on
 * what the project has installed (E2E pass 27).
 */
export function nearPackage(name: string, packages: readonly string[]): NearModule | undefined {
  const byName = spellingsOf(packages);
  // A slug that IS an installed package's (`auth`, with the catalogue down to
  // say so): that package, by its full name.
  const exact = byName.get(name);
  if (exact !== undefined && exact !== name) return { name, hit: exact, pkg: exact };
  return nearNames([name], byName)[0];
}

/** A near spelling: the name typed, the spelling it is one slip from, and the package that spelling means. */
export interface NearModule {
  name: string;
  hit: string;
  pkg: string;
}

/**
 * Each name's near spelling among `byName`'s keys (a spelling → the package it
 * means); an `@xano-sdk/` name is matched on its slug too.
 */
function nearNames(names: readonly string[], byName: ReadonlyMap<string, string>): NearModule[] {
  const spellings = [...byName.keys()];
  return names.flatMap((name) => {
    const bare = name.startsWith(FIRST_PARTY_SCOPE) ? name.slice(FIRST_PARTY_SCOPE.length) : name;
    const hit = suggest(bare, spellings) ?? suggest(name, spellings);
    return hit === undefined || hit === name ? [] : [{ name, hit, pkg: byName.get(hit)! }];
  });
}

/** `` `auth` (@xano-sdk/auth) `` for each near spelling, with the name it is for when `of` names were missed. */
function saidNear(near: readonly NearModule[], of: number): string {
  return near.map(({ name, hit, pkg }) => `\`${hit}\`${pkg === hit ? "" : ` (${pkg})`}${of > 1 ? ` for ${name}` : ""}`).join(", ");
}

/**
 * What a module name installs — resolved through the catalogue the way
 * `marketplace details` resolves it, BEFORE npm.
 *
 * A registry name is either a marketplace module or refused: a name — package
 * or slug — is looked up, and the module's own npm package is what is
 * installed, with any version or tag the argument carried. A name the
 * catalogue does not list is refused by name (exit 8); `is-number` is not a
 * module.
 *
 * A catalogue that cannot be reached still installs an `@xano-sdk/` name as
 * typed (changing what a project has installed must keep working when the
 * catalogue is down, and the scope is the marketplace's own), and refuses any
 * other name, which it cannot vouch for. A local specifier (`file:`, git, a
 * tarball) is not looked up at all.
 *
 * `command` names the command in every message (`xanosdk marketplace install`,
 * `xanosdk init --marketplace`).
 */
export async function resolveMarketplaceSpec(spec: string, command: string): Promise<string> {
  if (isLocalSpecifier(spec)) return spec;
  const name = packageNameOf(spec);
  const version = spec.length > name.length ? spec.slice(name.length) : "";
  let mod: CatalogueModule;
  try {
    mod = await fetchModule(name);
  } catch (err) {
    if (err instanceof ModuleNotFoundError) {
      throw await notFound(
        `\`${command}\`: ${name} is not in the Xano SDK marketplace, so nothing was installed.`,
        [name],
      );
    }
    if (name.startsWith(FIRST_PARTY_SCOPE)) return spec;
    const message =
      `\`${command}\`: could not reach the Xano SDK marketplace to confirm that ${name} is a ` +
      `module (${err instanceof Error ? err.message : String(err)}), so nothing was installed. An ` +
      `\`${FIRST_PARTY_SCOPE}\` module installs by its full name without it.`;
    throw isCatalogueOutage(err) ? new CatalogueUnreachableError(message) : new Error(message);
  }
  if (mod.deleted === true) {
    throw new MarketplaceModuleNotFoundError(
      `\`${command}\`: ${mod.npm_package ?? name} has been removed from the Xano SDK marketplace, so nothing was installed. ` +
        `Run \`xanosdk marketplace list\` for the modules that are published.`,
    );
  }
  const pkg = mod.npm_package ?? name;
  if (pkg !== name) info(`${name} is the marketplace module ${pkg}.`);
  return `${pkg}${version}`;
}

/**
 * {@link resolveMarketplaceSpec} over a list, refusing every unlisted name in
 * ONE message rather than the first of several — the reader fixes the command
 * line once.
 */
export async function resolveMarketplaceSpecs(specs: readonly string[], command: string): Promise<string[]> {
  const resolved: (string | undefined)[] = [];
  const missing: string[] = [];
  for (const spec of specs) {
    try {
      resolved.push(await resolveMarketplaceSpec(spec, command));
    } catch (err) {
      if (!(err instanceof MarketplaceModuleNotFoundError)) throw err;
      if (specs.length === 1) throw err;
      missing.push(packageNameOf(spec));
      resolved.push(undefined);
    }
  }
  if (missing.length > 0) {
    const { err, modules } = await notFoundWith(
      `\`${command}\`: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not in the Xano SDK marketplace, ` +
        `so nothing was installed.`,
      missing,
    );
    const fix = new Map(modules.map((m) => [m.name, m.pkg] as const));
    if (missing.every((name) => fix.has(name))) {
      err.corrected = specs.map((spec, i) => resolved[i] ?? fix.get(packageNameOf(spec))!);
    }
    throw err;
  }
  return resolved as string[];
}

/**
 * Where a `reinstall` / `remove` name was found: in this project (`project`), in
 * the catalogue only (`catalogue` — a real module this project does not have),
 * nowhere (`unlisted` — the catalogue answered no), or not checked
 * (`unknown` — the catalogue could not be reached, or a local specifier).
 */
export type ProjectModuleListing = "project" | "catalogue" | "unlisted" | "unknown";

/**
 * The package a `reinstall` / `remove` name refers to in THIS project.
 *
 * Those verbs act on what the project already has, so a name it depends on (or
 * records settings for) is taken as typed with no network at all — removal must
 * keep working when the catalogue does not. Anything else is looked up the way
 * `install` looks it up, and the module's package is what the name means:
 * `remove auth` removes the `@xano-sdk/auth` that `install auth` added, and a
 * second `remove auth` names `@xano-sdk/auth` as the module that is not installed.
 */
export async function resolveProjectModule(spec: string, dir: string): Promise<string> {
  return (await resolveProjectModuleListing(spec, dir)).pkg;
}

/** {@link resolveProjectModule}, with where the name was found. */
export async function resolveProjectModuleListing(
  spec: string,
  dir: string,
): Promise<{ pkg: string; listing: ProjectModuleListing }> {
  const manifest = readProjectManifest(dir);
  const known = new Set([
    ...(manifest === null ? [] : declaredDependencies(manifest)),
    ...Object.keys(readToolchainBlock(dir, manifest)),
  ]);
  if (isLocalSpecifier(spec)) {
    // A local directory is the package named in its package.json; the path is
    // only where it came from.
    const name = localPackageName(spec, dir);
    if (name === undefined) return { pkg: spec, listing: "unknown" };
    return { pkg: name, listing: known.has(name) ? "project" : "unknown" };
  }
  if (known.has(spec)) return { pkg: spec, listing: "project" };
  let mod: CatalogueModule;
  try {
    mod = await fetchModule(spec);
  } catch (err) {
    return { pkg: spec, listing: err instanceof ModuleNotFoundError ? "unlisted" : "unknown" };
  }
  if (mod.deleted === true && !known.has(mod.npm_package ?? spec)) return { pkg: spec, listing: "unlisted" };
  const pkg = mod.npm_package ?? spec;
  if (pkg !== spec) info(`${spec} is the marketplace module ${pkg}.`);
  return { pkg, listing: known.has(pkg) ? "project" : "catalogue" };
}

/**
 * The not-found failure `details` gives a name the catalogue does not list —
 * the sentence `install` gives the same name, less the "nothing was installed"
 * a read-only verb has no business saying.
 */
export async function notInMarketplaceError(command: string, name: string): Promise<MarketplaceModuleNotFoundError> {
  return notFound(
    `\`${command}\`: ${name} is not in the Xano SDK marketplace.`,
    [name],
  );
}

/**
 * The not-found failure `reinstall` / `remove` give a name neither this project
 * nor the catalogue knows — exit 8, like `install` and `details` for the same
 * name.
 */
export async function unlistedModuleError(command: string, name: string): Promise<MarketplaceModuleNotFoundError> {
  return notFound(
    `\`${command}\`: ${name} is not a dependency of this project and not in the Xano SDK marketplace.`,
    [name],
  );
}

/**
 * A catalogue outage as the transient failure it is: exit 8, with this run's
 * own command line to rerun once the catalogue answers. Anything else passes
 * through unchanged.
 */
export async function withCatalogueRerun(err: unknown, args: ParsedArgs, command: string): Promise<unknown> {
  if (!isCatalogueOutage(err)) return err;
  const { retryCommand } = await import("./retry-command.js");
  const rerun = retryCommand(args, { command }).command;
  return new CliError("SDK_ERROR", `${(err as Error).message}\nRun \`${rerun}\` again once it answers.`, {
    exitCode: EXIT_SOURCE_UNRESOLVABLE,
    details: { reason: "catalogue-unreachable", rerun },
    cause: err,
  });
}
