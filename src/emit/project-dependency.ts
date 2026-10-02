/**
 * Changing one dependency of the project at `dir` — adding a module, upgrading
 * the SDK, removing a module — the one way every command does it.
 *
 * The manager is aimed at the project ({@link installSite}); an npm workspace
 * member the root lockfile does not list yet is linked first; then the change
 * runs, and package.json and the resolver are read to see that it landed. The
 * manager's exit status is not the answer on its own: npm inside a member its
 * lockfile has not linked installs nothing into it and still exits 0.
 *
 * Node-only.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { shellWord } from "./command-line.js";
import { UsageError } from "./errors.js";
import { isLocalSpecifier } from "./marketplace-resolve.js";
import { localPackageName, localPathOf, packageNameOf, readInstalledManifestState } from "./module-manifest.js";
import { runNpmQuiet, type NpmRunOutput } from "./npm.js";
import { installWithPeerRetry, type PeerRetryResult } from "./npm-install.js";
import { installSite, npmLockListsMember, removeArgs, yarnPlugAndPlayRoot, type InstallSite } from "./package-manager.js";
import { trackLocalWrite } from "../util/sent-writes.js";

/**
 * How an interrupted change to `name` is settled: read what the project now
 * records, then re-run the command, which picks up what landed. `rerun` is the
 * command as the reader typed it, when the caller knows it.
 */
function interruptedCheck(name: string, site: InstallSite, rerun: string | undefined): string {
  const ls = site.manager === "npm" ? ` (\`npm ls ${name}\`)` : "";
  return `Check whether package.json lists ${name}${ls}, then re-run ${rerun === undefined ? "the command" : `\`${rerun}\``} — it picks up what landed.`;
}

/**
 * Refuse a project Yarn installs with Plug'n'Play, before anything runs. The
 * remedy names the `.yarnrc.yml` to change and the install to run, from where
 * the command was typed.
 */
export function refusePlugAndPlay(dir: string, rerun: string): void {
  const root = yarnPlugAndPlayRoot(dir);
  if (root === undefined) return;
  const rel = relative(process.cwd(), root).split(sep).join("/");
  const rc = rel === "" ? ".yarnrc.yml" : `${rel}/.yarnrc.yml`;
  // In a subshell, so the re-run that follows starts where the command was typed.
  const install = rel === "" ? "yarn install" : `(cd ${shellWord(rel)} && yarn install)`;
  throw new UsageError(
    `This project installs with Yarn Plug'n'Play, which Xano SDK does not support: the CLI, its modules and the ` +
      `scaffold's build read packages from node_modules. Add \`nodeLinker: node-modules\` to ${shellWord(rc)}, run ` +
      `\`${install}\`, then re-run \`${rerun}\`.`,
  );
}

/** Every dependency `dir`'s package.json records, by name, across its dependency blocks. */
export function dependenciesOf(dir: string): Map<string, string> {
  const deps = new Map<string, string>();
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    for (const block of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, range] of Object.entries((manifest[block] as Record<string, unknown> | undefined) ?? {})) {
        if (typeof range === "string") deps.set(name, range);
      }
    }
  } catch {
    // No readable manifest: nothing recorded.
  }
  return deps;
}

/** Where a dependency change runs, and the member link it needed first. */
export interface PreparedSite {
  readonly site: InstallSite;
  /** The link run, when the member needed one; a non-zero status is a failure to report. */
  readonly link: NpmRunOutput | null;
}

/**
 * {@link installSite}, with an npm workspace member the root lockfile does not
 * list linked into it first (`npm install -w <member>` at the root). Until it
 * is, npm records nothing added to, upgraded in or removed from the member.
 * `onLink` fires before the link runs, for a caller with a spinner to relabel.
 */
export async function prepareInstallSite(dir: string, onLink?: (member: string) => void): Promise<PreparedSite> {
  const site = installSite(dir);
  const member = site.scope[0] === "-w" ? site.scope[1] : undefined;
  if (member === undefined || npmLockListsMember(site.cwd, member)) return { site, link: null };
  onLink?.(member);
  const link = await runNpmQuiet(["install", ...site.scope], site.cwd);
  return {
    site,
    link: link.status === 0 ? link : { ...link, output: `Linking ${member} into the npm workspace at ${site.cwd} failed:\n${link.output}` },
  };
}

/** What adding one dependency did. */
export interface AddOutcome extends PeerRetryResult {
  readonly site: InstallSite;
  /** The specifier as the manager was given it: a path is rebased to where it ran. */
  readonly installSpec: string;
  /** The name the project's package.json records the dependency under, once the manager exited 0. */
  readonly recorded?: string;
  /**
   * {@link recorded}, when the project also resolves it. Undefined is a failed
   * add whatever the manager said.
   */
  readonly landed?: string;
}

/**
 * Add `specifier` to the project at `dir`: link the member if it needs it, run
 * the manager's add (with npm's peer retry), and read back where it landed.
 */
export async function addDependency(
  dir: string,
  specifier: string,
  opts: { readonly onRetry?: () => void; readonly onLink?: (member: string) => void; readonly rerun?: string } = {},
): Promise<AddOutcome> {
  const name = localPackageName(specifier, dir) ?? (isLocalSpecifier(specifier) ? specifier : packageNameOf(specifier));
  // From the member link on, the project may change under the run: an
  // interrupt says so rather than "Cancelled.".
  const check = interruptedCheck(name, installSite(dir), opts.rerun);
  return trackLocalWrite({ what: `the install of ${name}`, check }, async () => {
    const { site, link } = await prepareInstallSite(dir, opts.onLink);
    const installSpec = site.cwd === resolve(dir) ? specifier : rebaseSpec(specifier, dir, site.cwd);
    if (link !== null && link.status !== 0) return { ...link, peerConflict: null, retried: false, site, installSpec };
    const before = dependenciesOf(dir);
    const result = await installWithPeerRetry(installSpec, site.cwd, {
      ...(opts.onRetry === undefined ? {} : { onRetry: opts.onRetry }),
      scope: site.scope,
      ...(site.manager !== "npm" ? { manager: site.manager } : {}),
    });
    if (result.status !== 0) return { ...result, site, installSpec };
    const recorded = recordedDependency(dir, specifier, before);
    const landed = recorded !== undefined && readInstalledManifestState(dir, recorded).kind !== "absent" ? recorded : undefined;
    return { ...result, site, installSpec, ...(recorded === undefined ? {} : { recorded }), ...(landed === undefined ? {} : { landed }) };
  });
}

/** What removing one dependency did. */
export interface RemoveOutcome extends NpmRunOutput {
  readonly site: InstallSite;
  /** The manager exited 0 and the project's package.json still lists the package. */
  readonly stillListed: boolean;
}

/** Remove `pkg` from the project at `dir`, linking the member first, and read back that it left package.json. */
export async function removeDependency(dir: string, pkg: string, rerun?: string): Promise<RemoveOutcome> {
  return trackLocalWrite({ what: `the removal of ${pkg}`, check: interruptedCheck(pkg, installSite(dir), rerun) }, async () => {
    const { site, link } = await prepareInstallSite(dir);
    if (link !== null && link.status !== 0) return { ...link, site, stillListed: true };
    const args = [...removeArgs(site.manager, pkg), ...site.scope];
    const result = await (site.manager === "npm" ? runNpmQuiet(args, site.cwd) : runNpmQuiet(args, site.cwd, { manager: site.manager }));
    return { ...result, site, stillListed: result.status === 0 && dependenciesOf(dir).has(pkg) };
  });
}

/**
 * The name `specifier` is recorded under in `dir`'s package.json. A registry
 * spec, a local directory and a local tarball have a known name; a URL or git
 * spec is the one entry the add changed, or the one already recorded with that
 * exact spec.
 */
export function recordedDependency(dir: string, specifier: string, before: ReadonlyMap<string, string>): string | undefined {
  const after = dependenciesOf(dir);
  const known = localPackageName(specifier, dir) ?? (isLocalSpecifier(specifier) ? undefined : packageNameOf(specifier));
  const name =
    known ??
    ((): string | undefined => {
      const changed = [...after].filter(([n, range]) => before.get(n) !== range).map(([n]) => n);
      if (changed.length === 1) return changed[0];
      const same = [...after].filter(([, range]) => range === specifier).map(([n]) => n);
      return same.length === 1 ? same[0] : undefined;
    })();
  return name !== undefined && after.has(name) ? name : undefined;
}

/** A path specifier relative to `from`, rewritten relative to `to` (keeping `file:`); anything else unchanged. */
function rebaseSpec(spec: string, from: string, to: string): string {
  const path = localPathOf(spec);
  if (path === undefined || isAbsolute(path)) return spec;
  const abs = resolve(from, path);
  if (!existsSync(abs)) return spec;
  const rel = relative(resolve(to), abs).split(sep).join("/");
  const rebased = rel.startsWith("..") ? rel : `./${rel}`;
  return spec.startsWith("file:") ? `file:${rebased}` : rebased;
}
