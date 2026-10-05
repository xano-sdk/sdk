/**
 * A toolchain module's other peers, added to the project as direct
 * dependencies. Its own module, apart from both callers, because two commands
 * add them — `marketplace install`/`reinstall` and `init --marketplace` — and
 * a project scaffolded with a module has to end up with the same dependencies
 * as one that installed it later (R13).
 */
import { spinner, style, success, terminalText, warn } from "./ui.js";
import { moduleKind, packageNameOf, readInstalledManifest, readInstalledManifestState, requiredPeersOf } from "./module-manifest.js";
import { condenseNpmError } from "./npm.js";
import { addCommandFor } from "./package-manager.js";
import { addDependencies } from "./project-dependency.js";
import { readProjectManifest } from "./project-config.js";
import { satisfiesRange } from "./semver.js";
import { shellWord } from "./command-line.js";

/**
 * A toolchain module's peers other than `@xano/sdk`, added to the project as
 * direct dependencies — returns the specifiers added (`zod@^4.0.0`).
 *
 * A module that emits code importing `zod` peers on it, and the project's own
 * files are what import it. npm 7+ installs a missing peer, but not where every
 * manager this CLI supports would: yarn installs no peers, and pnpm does not
 * link one where a project file resolves it. A direct dependency resolves under
 * all of them, so each missing peer is added with the module's own range, in
 * one run of the project's manager.
 *
 * A peer the project already declares (dependencies, devDependencies,
 * peerDependencies, optionalDependencies) is the project's choice and is left
 * alone. When the version installed for it falls outside the module's range,
 * that is said: `semver.ts` answers whether a VERSION is in a range, not whether
 * two ranges meet, so the installed version is what is checked — and a peer not
 * on disk, or a range it cannot read, draws no opinion.
 *
 * Workspace modules are not touched: their peers are the backend's own imports,
 * and npm's ordinary peer handling is what their install has always relied on.
 */
export async function addToolchainPeers(dir: string, pkg: string, rerun: string): Promise<string[]> {
  const state = readInstalledManifestState(dir, pkg);
  if (state.kind !== "ok" || !isToolchainModule(pkg, state.manifest)) return [];
  const declared = projectDeclaredRanges(readProjectManifest(dir));
  const missing: string[] = [];
  for (const [peer, range] of requiredPeersOf(state.manifest)) {
    const has = declared.get(peer);
    if (has === undefined) {
      missing.push(`${peer}@${range}`);
      continue;
    }
    const version = readInstalledManifest(dir, peer)?.["version"];
    if (typeof version === "string" && satisfiesRange(version, range) === false) {
      warn(
        `${pkg} needs ${peer} ${range}, and this project has ${version} (declared ${has}) — left as it is.`,
        "module.peer-mismatch",
        [`Move it into range with \`${addCommandFor(dir, shellWord(`${peer}@${range}`))}\`, or keep it and expect ${pkg}'s output not to compile.`],
      );
    }
  }
  if (missing.length === 0) return [];

  const spin = spinner(`Adding ${missing.map((m) => style.bold(m)).join(", ")}`);
  let result: Awaited<ReturnType<typeof addDependencies>>;
  try {
    result = await addDependencies(dir, missing, {
      rerun,
      onRetry: () => spin.update(`Adding ${missing.join(", ")} (retrying with --legacy-peer-deps)`),
    });
  } finally {
    spin.stop();
  }
  // Quoted for the shell it is printed for: a range like `>=3.23 <5` holds a
  // space and a redirect. `addDependencies` gets the bare specs as argv.
  const command = addCommandFor(dir, missing.map(shellWord).join(" "));
  if (result.status !== 0 || result.unrecorded.length > 0) {
    // Not fatal: the module is installed and configured, and what is missing
    // is one command the reader can run — named, with the manager's reason.
    process.stderr.write(terminalText(result.output.trimEnd()) + "\n");
    warn(
      `${pkg} needs ${missing.join(", ")}, and ${result.status !== 0 ? `\`${command}\` failed (exit ${result.status})` : `\`${command}\` did not add ${result.unrecorded.join(", ")}`}.`,
      "module.peer-not-added",
      [`Run \`${command}\` once that is fixed — code ${pkg} generates imports ${missing.length === 1 ? "it" : "them"}.`],
    );
    return missing.filter((m) => !result.unrecorded.includes(packageNameOf(m)));
  }
  if (result.peerConflict !== null) {
    const refused = condenseNpmError(result.peerConflict);
    warn(
      `${missing.join(", ")} ${missing.length === 1 ? "declares" : "declare"} a peer range this project does not satisfy — installed with --legacy-peer-deps.`,
      "module.legacy-peer-deps",
      ["npm refused the tree it would otherwise have installed:", ...(refused !== "" ? [refused] : [])],
    );
  }
  success(
    `Added ${missing.join(", ")}, ${missing.length === 1 ? "a peer" : "peers"} ${pkg} needs, as ` +
      `${missing.length === 1 ? "a direct dependency" : "direct dependencies"}.`,
  );
  return missing;
}

/** Whether `manifest` declares a toolchain module. An unrecognized kind is the classifier's to report. */
function isToolchainModule(pkg: string, manifest: Record<string, unknown>): boolean {
  try {
    return moduleKind(pkg, manifest) === "toolchain";
  } catch {
    return false;
  }
}

/** Every name the project's package.json declares, in any dependency block, with its range. */
function projectDeclaredRanges(manifest: Record<string, unknown> | null): Map<string, string> {
  const ranges = new Map<string, string>();
  for (const block of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = manifest?.[block];
    if (typeof deps !== "object" || deps === null) continue;
    for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
      if (!ranges.has(name)) ranges.set(name, typeof range === "string" ? range : String(range));
    }
  }
  return ranges;
}
