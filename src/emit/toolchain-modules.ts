/**
 * Finding the toolchain modules a project has installed, and loading the ones
 * it has enabled.
 *
 * A toolchain module extends the CLI rather than the workspace: it contributes
 * questions to the questionnaire, contributions to the files the project owns,
 * and hooks that fire on `export`, `deploy` and `preflight`. See
 * `src/plugin.ts` for the contract.
 *
 * ── Config is read BEFORE anything is imported ──────────────────────────────
 *
 * Two rules, and the order between them is the point.
 *
 * The second rule is forced by the CLI: loading the user's entry file
 * unregisters the TypeScript loader, and a dynamic import after that trips over
 * it in a source checkout. So plugins must be imported BEFORE `loadDefault()`.
 *
 * That makes the first rule necessary. Importing eagerly on every command pulls
 * each plugin's whole module graph into every `compile`, `export`, `deploy` and
 * `preflight` — for a rendering module that is its emitter plus its vendored
 * kind data, paid for on runs that never call a hook. Reading the project's
 * `package.json` config block first is cheap JSON, and a module configured
 * `enabled: false` is then never imported at all.
 *
 * Hence three separately callable steps rather than one function: read config,
 * import what survives, fire. They happen at three different points in a
 * command.
 *
 * ── Why a load failure is conditionally fatal ───────────────────────────────
 *
 * On a normal run a module that fails to load is reported and skipped, matching
 * every other optional side effect in the CLI.
 *
 * Under `--frozen-lock` it is FATAL, and that asymmetry is the whole reason
 * this file thinks about failure at all. A frozen run is a guard: it exists to
 * fail when a committed artifact is stale. If a plugin fails to resolve in CI —
 * a partial install, a stale `xanosdk.plugin` path after a version bump — then
 * its `onBundle` never fires, nothing checks the tree, and `export
 * --frozen-lock` exits 0 against a tree that is wrong. The guard would FAIL
 * GREEN, which is strictly worse than failing red: a red guard gets fixed, a
 * green one gets trusted.
 *
 * ── And why a VERSION skew is unconditionally fatal ─────────────────────────
 *
 * One failure is not conditional at all. A module whose declared
 * `peerDependencies["@xano/sdk"]` range this SDK falls outside of is REFUSED
 * on every host and both postures, before its plugin file is imported, because
 * the thing it would otherwise do is indistinguishable from success — see
 * {@link assertSdkInPeerRange}. A warning would be scrolled past on exactly the
 * runs that needed it.
 *
 * Node-only; reached from the commands, which the CLI imports lazily.
 */

import type { ToolchainPlugin } from "../plugin.js";
import { UsageError } from "./errors.js";
import { satisfiesRange } from "./semver.js";
import {
  fileInPackage,
  loadFile,
  moduleKind,
  readInstalledManifestState,
  type ModuleKind,
} from "./module-manifest.js";
import {
  configuredPackages,
  declaredDependencies,
  readProjectManifest,
  readToolchainConfig,
  type ToolchainConfig,
} from "./project-config.js";
import { warn } from "./ui.js";

/** A toolchain module the project depends on, before anything is imported. */
export interface DeclaredPlugin {
  /** The package name. */
  readonly pkg: string;
  /**
   * The module's OWN version, read from its installed `package.json`.
   *
   * Carried because a contribution spliced into a user-owned file is stamped
   * with the version that generated it, and only the installed manifest knows
   * what that is. {@link UNKNOWN_MODULE_VERSION} when the module declares none
   * or could not be read — a missing version is a cosmetic gap in a comment,
   * never a reason to refuse a module that otherwise works.
   */
  readonly version: string;
  /** The project's config block for it, or null when it records none. */
  readonly config: ToolchainConfig | null;
  /** The resolved `xanosdk.plugin` file, or null when it is not on disk. */
  readonly pluginFile: string | null;
  /**
   * The range the module declares for `@xano/sdk` in `peerDependencies`, or
   * null when it declares none.
   *
   * Read here because this is the only place that holds the module's own
   * manifest, and checked before the import because an out-of-range SDK is the
   * one skew the SDK cannot detect from the plugin OBJECT — see
   * {@link assertSdkInPeerRange}.
   */
  readonly sdkPeerRange: string | null;
  /**
   * Why this entry cannot be used, when reading it already failed.
   *
   * A declared dependency whose own `package.json` is on disk but does not
   * parse cannot be classified at all — we cannot tell whether it is a
   * toolchain module, so we cannot tell whether a check just went missing.
   * Carried through as a declaration rather than dropped, so the frozen guard
   * gets to refuse it.
   */
  readonly unreadable?: string;
}

/** A toolchain module that has been imported and checked. */
export interface LoadedPlugin {
  readonly pkg: string;
  /** The module's own version, for stamping what it contributes. */
  readonly version: string;
  readonly plugin: ToolchainPlugin;
  readonly config: ToolchainConfig;
}

/** What a module's version reads as when its manifest declares none. */
export const UNKNOWN_MODULE_VERSION = "unknown";

/** A module that was declared but could not be used, and why. */
export interface SkippedPlugin {
  readonly pkg: string;
  readonly why: string;
}

/** What discovery found. */
export interface Discovery {
  readonly loaded: readonly LoadedPlugin[];
  readonly skipped: readonly SkippedPlugin[];
  /**
   * Loaded modules the project's `"xanosdk"` block does not name — the
   * enabled-with-no-settings state.
   *
   * THE one definition of "unconfigured", computed here and read by everyone.
   * The reconciler takes this list rather than deriving its own, so the thing a
   * `deploy` warns about is computed by the code that later repairs it and the
   * two cannot drift into different opinions.
   */
  readonly unconfigured: readonly string[];
}

/**
 * Whether a config block leaves the module switched on.
 *
 * Absent config means enabled. A project that installed a toolchain module and
 * said nothing else about it wants what the module does — that is why it is in
 * `dependencies`. Only an explicit `enabled: false` turns it off.
 */
function isEnabled(config: ToolchainConfig | null): boolean {
  return config?.["enabled"] !== false;
}

/**
 * STEP ONE — which toolchain modules this project declares, and what it has
 * said about them. Reads JSON only; imports nothing.
 */
export function declaredToolchainPlugins(projectDir: string): readonly DeclaredPlugin[] {
  const projectManifest = readProjectManifest(projectDir);
  if (projectManifest === null) return [];
  const declared: DeclaredPlugin[] = [];
  // Packages this project has CONFIGURED. That block is only ever written for a
  // toolchain module, so a name in it is the project stating that one is
  // expected — which is the only way to tell an uninstalled toolchain module
  // from an ordinary dependency that simply is not one.
  const configured = new Set(configuredPackages(projectDir, projectManifest));

  for (const pkg of declaredDependencies(projectManifest)) {
    const state = readInstalledManifestState(projectDir, pkg);
    if (state.kind === "absent") {
      // An ordinary dependency that is not installed is not this file's
      // business. One the project CONFIGURES as a toolchain module is: its
      // check would otherwise disappear with no output at all, and a frozen
      // run would exit 0 having verified nothing — the exact fail-green this
      // loader exists to prevent.
      if (configured.has(pkg)) {
        declared.push({
          pkg,
          version: UNKNOWN_MODULE_VERSION,
          config: null,
          pluginFile: null,
          sdkPeerRange: null,
          unreadable: `it is configured in this project's package.json but is not installed`,
        });
      }
      continue;
    }
    if (state.kind === "unreadable") {
      // A broken install. We cannot read far enough to know whether this was a
      // toolchain module, so we cannot rule out that a check just vanished —
      // which is precisely the case the frozen guard exists for. Reported
      // rather than dropped; `isEnabled(null)` keeps it in the enabled set so
      // discovery sees it.
      declared.push({
        pkg,
        version: UNKNOWN_MODULE_VERSION,
        config: null,
        pluginFile: null,
        sdkPeerRange: null,
        unreadable: state.why,
      });
      continue;
    }
    const manifest = state.manifest;
    // An unrecognized kind is a typo in the MODULE's own manifest. Reported and
    // skipped, never thrown: this loop runs inside `marketplace install`'s
    // reconcile, AFTER npm has already mutated the project, so a throw reports
    // completed work as failed over a remedy that is not this project's to
    // make. Skipping loses nothing either — an unrecognized kind is not
    // "toolchain", which is the only thing this loop asks. `classifyInstalled`
    // in `marketplace-command.ts` already decided it this way; this is the
    // loader path that was missed.
    let kind: ModuleKind;
    try {
      kind = moduleKind(pkg, manifest);
    } catch (error) {
      warn(
        `${pkg} does not declare a module kind we recognize, so it is read as an ordinary package.`,
        "module.kind-unknown",
        [error instanceof Error ? error.message : String(error)],
      );
      continue;
    }
    if (kind !== "toolchain") continue;
    const field = manifest["xanosdk"] as Record<string, unknown>;
    const declaredPath = field["plugin"];
    const config = readToolchainConfig(projectDir, pkg, projectManifest);
    declared.push({
      pkg,
      version: manifestVersion(manifest),
      config,
      pluginFile:
        typeof declaredPath === "string" && declaredPath !== ""
          ? fileInPackage(projectDir, pkg, declaredPath)
          : null,
      sdkPeerRange: declaredSdkPeerRange(manifest),
    });
  }
  return declared;
}

/**
 * The range a module declares for `@xano/sdk`, or null when it declares none.
 *
 * `peerDependencies` ONLY. The contract says `@xano/sdk` is a peer and never
 * a dependency — a module that bundles its own copy is already broken in a way
 * this check cannot describe — and reading a second field would refuse modules
 * over a manifest mistake that has nothing to do with contract skew.
 */
function declaredSdkPeerRange(manifest: Record<string, unknown>): string | null {
  const peers = manifest["peerDependencies"];
  if (typeof peers !== "object" || peers === null) return null;
  const range = (peers as Record<string, unknown>)["@xano/sdk"];
  return typeof range === "string" && range.trim() !== "" ? range : null;
}

/**
 * The SDK range `manifest` declares that `sdkVersion` is DEFINITIVELY outside
 * of, or null when there is no skew to report.
 *
 * Null covers three different situations on purpose, because none of them is a
 * mismatch: the module declares no peer, the range is a shape
 * {@link satisfiesRange} declines to read, or the running version cannot be
 * compared (a source checkout's `"unknown"`, a prerelease CLI — the case npm's
 * own peer resolution gets WRONG, since it excludes prereleases from every
 * range a module declares).
 *
 * Exported because the installers ask this question too. `marketplace install`
 * and `init --marketplace` must not leave a module on disk that the very next
 * load would refuse, and a second reading of the same field somewhere else is
 * how the installer and the loader end up disagreeing about the same manifest.
 */
export function sdkPeerSkew(
  manifest: Record<string, unknown>,
  sdkVersion: string,
): string | null {
  const range = declaredSdkPeerRange(manifest);
  if (range === null) return null;
  return satisfiesRange(sdkVersion, range) === false ? range : null;
}

/** A module's declared version, or {@link UNKNOWN_MODULE_VERSION}. */
function manifestVersion(manifest: Record<string, unknown>): string {
  const version = manifest["version"];
  return typeof version === "string" && version !== "" ? version : UNKNOWN_MODULE_VERSION;
}

/**
 * Refuse a module whose declared peer range this SDK is outside of, BEFORE
 * importing it.
 *
 * ── The skew no shape check can see ─────────────────────────────────────────
 *
 * `assertContractShape` refuses a module built against a contract that is
 * OLDER than this SDK's, by recognizing the shape it left behind. The opposite
 * direction cannot work that way: a module built against a NEWER contract has
 * hooks this SDK has never heard of, and every hook is optional, so it loads,
 * registers, and contributes nothing — reported as the ordinary outcome
 * "contributed nothing", which is what a module with nothing to add looks like.
 * The check that would name it would have to ship in the SDK that predates the
 * change, so no SDK can ever carry it. The asymmetry is permanent, and it is
 * not specific to any one rename.
 *
 * The module's own declared range is the fact that IS available to both sides,
 * so it is what this reads. A module cannot do this for itself at the moment it
 * matters: `sdkVersion` reaches it only through `onBundle` and `onPreflight`,
 * which fire on `export` and `deploy` — long after the reconcile that quietly
 * wrote nothing. The install-time peer warning does not cover it either, being
 * routinely bypassed by `--legacy-peer-deps`, by pnpm/yarn peer handling, or by
 * an SDK downgraded after the install.
 *
 * ── Why a refusal rather than a skip ────────────────────────────────────────
 *
 * A skip is a warning that `export` and `deploy` scroll past, and the entire
 * failure being closed here is that it LOOKS EXACTLY LIKE SUCCESS. So this
 * throws on every host and both postures, frozen or not, the same way a
 * contract-skew refusal does: it is deterministic, and re-running cannot fix
 * it.
 *
 * The message carries the escape hatch because someone pinned to an older SDK
 * must not be locked out of every command by one module. `"enabled": false` is
 * read before this runs, so switching the module off is a working remedy, and
 * `marketplace remove` uninstalls before it reconciles — so the verb that drops
 * the module for good never reaches this guard either.
 *
 * Silent on anything it cannot compare: an SDK version that is not semver (a
 * source checkout reads `"unknown"`), a module that declares no peer, and a
 * range shape `satisfiesRange` declines to parse. A guard that costs a working
 * module over its own parser's gap would be worse than the silence.
 */
function assertSdkInPeerRange(declared: DeclaredPlugin, sdkVersion: string): void {
  const range = declared.sdkPeerRange;
  if (range === null) return;
  if (satisfiesRange(sdkVersion, range) !== false) return;
  throw new UsageError(
    `${declared.pkg} requires \`@xano/sdk\` ${range}, and this is ${sdkVersion} — so it would ` +
      `load, register, and apply nothing, which reads exactly like a module that had nothing to add.`,
    {
      suggestion:
        `Upgrade the SDK with \`npm install @xano/sdk@latest\`, or install a ${declared.pkg} ` +
        `built for this one. To carry on without it, set \`"${declared.pkg}": { "enabled": false }\` ` +
        `in this project's package.json "xanosdk" block, or run ` +
        `\`xanosdk marketplace remove ${declared.pkg}\` to drop it and its settings together.`,
    },
  );
}

/**
 * STEP TWO — import the enabled ones.
 *
 * Call this BEFORE the user's entry file is loaded; see the module header.
 *
 * `frozen` selects the failure posture rather than the work: the same modules
 * are found either way, and only what happens to a broken one changes.
 */
export async function discoverToolchainPlugins(
  projectDir: string,
  opts: DiscoveryOptions,
): Promise<Discovery> {
  const loaded: LoadedPlugin[] = [];
  const skipped: SkippedPlugin[] = [];
  const unconfigured: string[] = [];
  // Resolved on first need and then reused, never up front. `readVersion` walks
  // up to six directories doing a read and a parse at each, and discovery runs
  // on every command that touches a project — so a project with no toolchain
  // module, or none declaring a peer range, must not pay for it. Lazily
  // imported as well: `cli.ts` imports the commands that import this file, so a
  // static import would close a cycle.
  let sdkVersion = opts.sdkVersion;
  const runningSdkVersion = async (): Promise<string> =>
    (sdkVersion ??= (await import("./cli.js")).readVersion());

  for (const declared of declaredToolchainPlugins(projectDir)) {
    // What the project stores, with this run's pending change folded in. See
    // `DiscoveryOptions.configOverride`.
    const override = opts.configOverride?.[declared.pkg];
    const config =
      override === undefined
        ? declared.config
        : { ...(declared.config ?? {}), ...override };

    // A disabled module is never imported — not imported and then ignored.
    // That is the whole value of reading config first.
    if (!isEnabled(config)) continue;

    if (declared.unreadable !== undefined) {
      skipped.push({ pkg: declared.pkg, why: declared.unreadable });
      continue;
    }

    // BEFORE the import, from the manifest alone: a module built for a newer
    // SDK may fail obscurely at its own top level, and a refusal naming the
    // version skew has to win that race.
    if (declared.sdkPeerRange !== null) {
      assertSdkInPeerRange(declared, await runningSdkVersion());
    }

    if (declared.pluginFile === null) {
      skipped.push({
        pkg: declared.pkg,
        why: `its package.json names no "xanosdk": { "plugin": … } file we could find on disk`,
      });
      continue;
    }

    const entry = await loadFile(declared.pluginFile);
    if (entry.kind !== "loaded") {
      skipped.push({ pkg: declared.pkg, why: entry.why });
      continue;
    }

    const candidate = entry.exports["default"];
    if (typeof candidate !== "object" || candidate === null) {
      skipped.push({ pkg: declared.pkg, why: "its plugin file has no default export" });
      continue;
    }
    // Manifest and module must agree. A mismatch means one of the two is stale,
    // and guessing which would run code the manifest did not describe.
    if ((candidate as { kind?: unknown }).kind !== "toolchain") {
      skipped.push({
        pkg: declared.pkg,
        why: `its default export does not declare kind: "toolchain", but its package.json does`,
      });
      continue;
    }

    // Absent config, not empty config. `readToolchainConfig` answers null
    // exactly when the project's `"xanosdk"` block does not name the package,
    // which is the fact that matters — a `"pkg": {}` entry is a module that HAS
    // been through the questionnaire and asked for nothing.
    if (declared.config === null) unconfigured.push(declared.pkg);

    loaded.push({
      pkg: declared.pkg,
      version: declared.version,
      plugin: candidate as ToolchainPlugin,
      config: config ?? {},
    });
  }

  if (skipped.length > 0) reportSkipped(skipped, opts.frozen);
  // Once per discovery, and every command discovers once — so `export` and
  // `deploy` each say this a single time, not once per hook and not once per
  // phase. Suppressed for the hosts that are ABOUT TO ASK: telling someone to
  // run the verb they are already running is noise, and the reconciler reports
  // what it could not configure itself.
  if (opts.configuring !== true) reportUnconfigured(unconfigured);
  return { loaded, skipped, unconfigured };
}

/** What discovery was asked for. */
export interface DiscoveryOptions {
  /** Whether a module that could not be loaded is fatal. See the module header. */
  readonly frozen: boolean;
  /**
   * This caller runs the questionnaire itself, so the unconfigured report is
   * its to make. `init` and the reconciler; nobody else.
   */
  readonly configuring?: boolean;
  /**
   * Settings to fold over what the project stores, IN MEMORY, per package.
   *
   * Discovery decides what to import by reading `enabled` off disk, which used
   * to mean a caller wanting to re-enable a module had to WRITE the flag first
   * and hope the run that followed succeeded — a write outside the reconciler's
   * all-or-nothing write, which left the module switched on when the reconcile
   * then refused. Handing the pending change to discovery instead lets the
   * decision and the record of it land together, in the one atomic write.
   *
   * Merged over the stored block, so every other setting the project chose
   * survives and a module's `answersFromConfig` still reads its own values.
   * It does NOT make an unconfigured module look configured:
   * {@link Discovery.unconfigured} is computed from what is on disk, because
   * that is the fact it reports.
   */
  readonly configOverride?: Readonly<Record<string, ToolchainConfig>>;
  /**
   * The running `@xano/sdk` version the peer-range check compares against.
   *
   * Defaults to the installed SDK's own manifest, which is what every command
   * wants. A caller passes it only to test the check itself — the guard is
   * about versions, so its tests cannot be pinned to whatever this repo's
   * package.json happens to say today.
   */
  readonly sdkVersion?: string;
}

/**
 * Say which declared modules the project has never configured.
 *
 * A package in `dependencies` with no config block is ENABLED WITH NO SETTINGS:
 * `isEnabled(null)` is true, so the next `deploy` fires its `onBundle` with
 * `config: {}` and it runs on its own fallbacks with nothing the project chose.
 *
 * Reported HERE, on every discovery, because the CLI is not the likeliest way a
 * module arrives. A plain `npm install`, a merged PR, a `git pull` that changed
 * `package.json` — none of them run a xanosdk verb, and a report scoped to
 * `marketplace install` would miss exactly the population that needs it.
 *
 * A warning and never a prompt: `export` and `deploy` may say this, but they
 * must not stop to ask, and they write nothing on account of it. It names the
 * verb that fixes it because the fix is not guessable — `marketplace install`
 * on a package that is ALREADY installed reads as a no-op until you know it
 * reconciles.
 */
function reportUnconfigured(unconfigured: readonly string[]): void {
  if (unconfigured.length === 0) return;
  warn(
    `${unconfigured.length === 1 ? "A toolchain module is" : `${unconfigured.length} toolchain modules are`} ` +
      `installed but never configured, so ${unconfigured.length === 1 ? "it runs on its" : "they run on their"} ` +
      `own defaults with nothing this project chose.`,
    "module.unconfigured",
    unconfigured.map((pkg) => `${pkg} — configure it with \`xanosdk marketplace install ${pkg}\``),
  );
}

/**
 * Report what could not be loaded — a warning normally, a refusal when frozen.
 *
 * The frozen message says what the consequence would have been, not just what
 * failed. "It could not be loaded" leaves a reader to work out why that matters
 * during a `--frozen-lock` run; saying the check did not run makes the severity
 * legible at the point of failure.
 *
 * It also names `marketplace remove`, because the commonest way to reach this
 * failure is a plain `npm uninstall`: the dependency goes, the `"xanosdk"` block
 * survives, and `declaredToolchainPlugins` synthesizes a configured-but-absent
 * entry that fails every frozen run until someone hand-edits `package.json`.
 * Whoever reads this message is usually holding exactly that, so the recovery
 * instruction has to be here rather than only on the verb they did not run.
 */
function reportSkipped(skipped: readonly SkippedPlugin[], frozen: boolean): void {
  if (frozen) {
    throw new UsageError(
      `${skipped.length === 1 ? "A toolchain module" : `${skipped.length} toolchain modules`} ` +
        `could not be loaded, so whatever ${skipped.length === 1 ? "it checks was" : "they check were"} ` +
        `not checked — and this run was asked to verify, not to write:\n` +
        skipped.map((s) => `  ${s.pkg} — ${s.why}`).join("\n") +
        `\n\nRun \`xanosdk marketplace reinstall <package>\` to repair one that should still be here, ` +
        `or \`xanosdk marketplace remove <package>\` to drop it and its settings together. ` +
        `A plain \`npm uninstall\` leaves the settings behind, and a module this project still ` +
        `configures but no longer has installed is exactly what fails a frozen run.`,
    );
  }
  warn(
    `${skipped.length === 1 ? "A toolchain module" : `${skipped.length} toolchain modules`} could not be loaded and ${skipped.length === 1 ? "was" : "were"} skipped.`,
    "toolchain.load-failed",
    skipped.map((s) => `${s.pkg} — ${s.why}`),
  );
}
