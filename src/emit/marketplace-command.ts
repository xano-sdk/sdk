/**
 * `xanosdk marketplace` — find add-ons, then add one to the project you are
 * standing in.
 *
 * Six verbs. Three of them read the public catalogue (`list`, `search`,
 * `details`) and take no credentials at all; the other three (`install`,
 * `reinstall`, `remove`) touch no network and shell out to npm. That split is
 * deliberate: discovery must work before you have logged in, and changing what
 * a project has installed must keep working when the catalogue does not.
 *
 * Every read verb prints a formatted summary to a terminal and stable JSON to a
 * pipe, the same fork `profile me` and `ephemeral list` use. An agent gets the
 * machine shape by doing what an agent already does, with no flag to discover.
 *
 * ── `xanosdk marketplace install <package>` ───────────────────────────────────
 *
 * The install itself is `npm install <package>`, verbatim. What the command adds
 * over typing that yourself is the three things npm will not do for you:
 *
 *   • it puts add-ons on the CLI's map, so `xanosdk --help` says they exist;
 *   • it refuses BEFORE npm runs when the working directory is not a project;
 *   • it RECONCILES afterwards, so a toolchain module that arrived is asked its
 *     questions and the project records the answers.
 *
 * The second one is the oldest reason the command exists. Run `npm install` from
 * a parent directory and npm cheerfully creates or mutates the wrong
 * `package.json` and tells you it succeeded — a silent failure that is tedious
 * to notice and worse to undo.
 *
 * The third is `syncContributions`, and this command contributes nothing to it
 * beyond calling it. The reconciler reads every dependency rather than the name
 * just typed, so this file never recovers a package name from a `file:`, tarball
 * or git specifier in order to configure it — and a module that arrived through
 * a plain `npm install` or a merged PR is configured by this run too.
 *
 * The package name is resolved through the catalogue first (see
 * `marketplace-resolve.ts`): `install auth` installs `@xano-sdk/auth`, the module
 * `details auth` describes, and a name the catalogue does not list is refused
 * (exit 8). Version and tag specifiers ride along; a local specifier (`file:`,
 * git, a tarball) is installed as typed.
 *
 * Node-only (`node:fs` + the npm spawn); reached only through the lazy
 * `await import` in cli.ts, so the browser-safe authoring bundle never pulls it
 * in.
 */
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ParsedArgs, RouteManifestRefresh } from "./cli.js";
import { backendDirIn } from "./backend-dir.js";
import { isProjectDir } from "./xanosdk-project.js";
import { relForwardSlash } from "../util/rel-path.js";
import { installedCliAt, spellProjectCli } from "./invocation.js";
import { callsImportedAtTop, registerState, registerWrappers, withoutComments } from "./register-calls.js";
import { missingArgument, unknownFlag, UsageError } from "./errors.js";
import { indentBlock } from "./help.js";
import {
  fetchCatalogue,
  fetchModule,
  searchCatalogue,
  ModuleNotFoundError,
  type CatalogueModule,
  type CatalogueRow,
} from "./marketplace-catalogue.js";
import {
  localPackageName,
  localPathOf,
  moduleKind,
  packageNameOf,
  readInstalledManifestState,
} from "./module-manifest.js";
import {
  isLocalSpecifier,
  MarketplaceModuleNotFoundError,
  resolveMarketplaceSpec,
  resolveMarketplaceSpecs,
  resolveProjectModuleListing,
  notInMarketplaceError,
  unlistedModuleError,
  nearPackage,
  type ProjectModuleListing,
} from "./marketplace-resolve.js";
import { condenseNpmError } from "./npm.js";
import { type PeerRetryResult } from "./npm-install.js";
import { addCommandFor, installCommandFor, removeArgs, removeCommandFor } from "./package-manager.js";
import {
  type AddOutcome,
  type RemoveOutcome,
  addDependency,
  refusePlugAndPlay,
  removeDependency,
} from "./project-dependency.js";
import { addToolchainPeers } from "./toolchain-peers.js";
import { retryCommand } from "./retry-command.js";
import {
  declaredDependencies,
  readProjectManifest,
  readToolchainBlock,
} from "./project-config.js";
import { assertProjectDir } from "./project-dir.js";
import type { DeclaredPlugin } from "./toolchain-modules.js";
import { isMachineOutput, writeJson } from "./output.js";
import { canPrompt } from "./plugin-prompt.js";
import type { SyncResult } from "./sync-contributions.js";
import { blank, detail, formatFields, info, printHuman, safeText, spinner, stdoutStyle, style, success, terminalText, warn } from "./ui.js";

/**
 * The package argument, validated.
 *
 * A leading dash is refused rather than forwarded: npm would read it as a flag,
 * so `marketplace install --global` would silently become a global install
 * nobody asked for. The parser already routes unrecognized leading-dash tokens
 * to `unknownFlags` instead of `positionals`, so this is a second lock on a door
 * that is already shut — which is the right number of locks for a check whose
 * failure mode is "installed to the wrong place and said it worked".
 */
function resolvePackage(
  args: ParsedArgs,
  verb: "install" | "details" | "reinstall" | "remove" = "install",
): string {
  const typed = args.positionals[0];
  // `npm:<name>` is npm's spelling of the registry package itself, and
  // `<alias>@npm:<name>` its alias form: a module registers under its own
  // name, so the package after `npm:` is the one meant.
  const pkg = typed === undefined ? typed : (/^(?:(?:@[^/\s]+\/)?[^@/\s]+@)?npm:(.+)$/i.exec(typed)?.[1] ?? typed);
  if (pkg === undefined || pkg === "") {
    throw missingArgument("package", { command: "marketplace", subcommand: verb });
  }
  if (verb !== "details" && !pkg.startsWith("-") && packageNameOf(pkg) === "@xano/sdk") {
    throw new UsageError(
      `\`xanosdk marketplace ${verb}\` manages modules, and @xano/sdk is the SDK this project is built on, not a module` +
        (verb === "remove" ? ` — the backend cannot load without it.` : `.`) +
        ` To move it to the latest release, run \`xanosdk upgrade\`.`,
    );
  }
  if (pkg.startsWith("-")) {
    throw new UsageError(
      verb === "details"
        ? `\`xanosdk marketplace details\`: "${pkg}" starts with a dash, so it is a mistyped flag, not a package.`
        : `\`xanosdk marketplace ${verb}\`: "${pkg}" starts with a dash, so npm would read it as a flag, not a package.`,
      { helpFor: { command: "marketplace", subcommand: verb } },
    );
  }
  return pkg;
}

/**
 * The three writing verbs' shared opening: refuse the flag that belongs to
 * another verb, validate the package argument, and refuse a working directory
 * that is not a project — in that order, all of it BEFORE npm can be spawned,
 * so a bad invocation never touches disk.
 *
 * The directory refusal is the oldest reason this command exists: run `npm
 * install` from a parent directory and npm cheerfully mutates the wrong
 * `package.json` and reports success. Written once, so all three verbs refuse
 * the same way rather than two of them and whichever was added last.
 *
 * Only the verb differs, and every string is derived from it. What each verb
 * does AFTER this is genuinely different — `install` has no pre-refusal,
 * `reinstall` has four, `remove` has three and may skip npm entirely — so this
 * is a shared preamble and deliberately not a shared command template.
 */
function openVerb(
  args: ParsedArgs,
  verb: "install" | "reinstall" | "remove",
): { pkg: string; dir: string } {
  refusePromptFlag(args, verb);
  const pkg = resolvePackage(args, verb);
  const dir = process.cwd();
  assertProjectDir(dir, {
    what: `\`xanosdk marketplace ${verb}\` runs inside a Xano SDK project`,
    remedy: "cd into your project first, or run `xanosdk init` to create one.",
  });
  if (verb !== "remove") refuseOutsideXanoSdkProject(dir, verb);
  refusePlugAndPlay(dir, retryCommand(args, { command: `marketplace ${verb}` }).command);
  return { pkg, dir };
}

/**
 * A `package.json` is not a Xano SDK project: `install auth` in any npm
 * directory installed the module and then said to import it in a
 * `xano/index.ts` that did not exist. A module is wired into a backend, so the
 * directory must be a project `status` recognises. `remove` is left alone: taking a dependency away needs no backend.
 */
function refuseOutsideXanoSdkProject(dir: string, verb: "install" | "reinstall"): void {
  if (isProjectDir(dir)) return;
  throw new UsageError(
    `\`xanosdk marketplace ${verb}\` wires a module into a Xano SDK project, and ${dir} is not one — ` +
      `it has no backend entry (\`xano/index.ts\`) and no \`.xano/\` from an earlier deploy.\n` +
      "  cd into your project first, or run `xanosdk init` to create one.",
  );
}

/**
 * `install auth,chatbot` — the comma list `init --marketplace` takes. Each name
 * is looked up the way `init` looks them up, so a name the catalogue does not
 * list is refused with ITS near spelling (`suggestion`/`suggestions`), not the
 * whole list as one unknown name with a search that finds nothing (E2E pass 28).
 * When every name is listed, the refusal names one install per module: this
 * verb installs, wires and reconciles ONE module.
 */
async function refuseCommaList(spec: string): Promise<void> {
  if (isLocalSpecifier(spec) || !spec.includes(",")) return;
  const names = [...new Set(spec.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
  if (names.length < 2) return;
  const pkgs = await resolveMarketplaceSpecs(names, "xanosdk marketplace install").catch((err: unknown) => {
    // A miss one slip from a listed module: the corrected list, spelled as the
    // installs this verb runs — one per module — so following the did-you-mean
    // does not walk straight into the one-at-a-time refusal below (E2E pass 29).
    if (!(err instanceof MarketplaceModuleNotFoundError) || err.corrected === undefined) throw err;
    const fixed = new MarketplaceModuleNotFoundError(
      `${err.message} It installs one module at a time: ` +
        `run ${err.corrected.map((p) => `\`xanosdk marketplace install ${p}\``).join(", then ")}.`,
      err.suggestions ?? (err.suggestion === undefined ? [] : [err.suggestion]),
    );
    throw fixed;
  });
  throw new UsageError(
    `\`xanosdk marketplace install\` installs one module at a time, and "${spec}" names ${pkgs.length}. ` +
      `Run ${pkgs.map((p) => `\`xanosdk marketplace install ${p}\``).join(", then ")}.`,
    { hintFor: { command: "marketplace", subcommand: "install" } },
  );
}

export async function runMarketplaceInstallCommand(args: ParsedArgs): Promise<void> {
  const opened = openVerb(args, "install");
  const dir = opened.dir;
  await refuseCommaList(opened.pkg);
  // The catalogue's module, not the argument as typed: `install auth` installs
  // `@xano-sdk/auth`, the package `details auth` describes.
  const pkg = await resolveMarketplaceSpec(opened.pkg, "xanosdk marketplace install");

  // BEFORE npm, because afterwards it is always true. It decides whether a
  // peer-range refusal may undo the install: only a package this run ADDED is
  // one this run may take away again.
  //
  // By the package NAME: a local directory is the package its package.json
  // names, never the path it was typed as.
  const name = localPackageName(pkg, dir) ?? packageNameOf(pkg);
  const projectManifest = readProjectManifest(dir);
  const added = projectManifest === null || !isDependency(projectManifest, name);

  // Already a dependency and on disk, and no version asked for: there is
  // nothing for npm to do, and re-running it (spinner and all) read as a fresh
  // install of a module the project already has. Said, and skipped; the
  // reconcile and the wiring hint below still run — they are why a second
  // `install` of an unwired module is typed at all. A local directory counts
  // only when the dependency already points at that same directory. On disk is
  // wherever the project resolves it — hoisted to a workspace root included.
  const sameSource = pkg === name || sameLocalSource(dir, pkg, projectManifest, name);
  const alreadyInstalled = !added && sameSource && readInstalledManifestState(dir, name).kind !== "absent";
  // A flag no module question can claim is refused BEFORE npm runs whenever the
  // questions are already knowable — the module is on disk and a dependency —
  // and otherwise straight after npm, undoing what this run added, and before
  // `Installed` is printed. It used to be refused by the reconcile, after the
  // install had been announced: `✓ Installed` and then `Unknown flag --bogus`.
  if (alreadyInstalled) await refuseUnclaimedFlags(args, dir, "install");
  const installed = alreadyInstalled
    ? null
    : await install(pkg, dir, "install", retryCommand(args, { command: "marketplace install" }).command);
  if (!alreadyInstalled) await refuseUnclaimedFlags(args, dir, "install", added ? { undo: name } : {});

  // Before `Installed` is printed: a module this SDK cannot run is not an
  // install to announce and then contradict.
  await assertInstalledSdkPeer(name, dir, { undo: added, verb: "install" });

  // The blank line parts npm's own output from ours; with no npm run it is a stray line.
  if (!alreadyInstalled) blank();
  const shown = pkg === name ? pkg : `${name} (${pkg})`;
  if (alreadyInstalled) info(`${shown} is already installed — npm was not run.`);
  else success(`Installed ${shown}.`);

  // ── Install, then RECONCILE ───────────────────────────────────────────────
  //
  // Nothing here classifies what was just installed or patches anything on its
  // account. The reconciler reads every dependency and the project's stored
  // config and produces the state both imply — so a module installed from
  // `file:../local`, a tarball or a git URL is configured correctly with no
  // name recovered from the specifier, and a module that arrived some other way
  // entirely (a plain `npm install`, a merged PR) is configured by this run too.
  //
  // `ask: "unanswered"` puts the questionnaire only to modules the project has
  // never answered for. It is also where this command discharges the obligation
  // that comes with `deferUnknownFlags`: the plugin flags the parser carried
  // through are claimed by the questions that derive them, and whatever nothing
  // claims is refused BY NAME, naming `marketplace install` rather than `init`.
  const { syncContributions } = await import("./sync-contributions.js");
  const sync = await syncContributions(dir, {
    apply: true,
    ask: "unanswered",
    host: "install",
    json: args.json,
    unknownFlags: args.unknownFlags,
  });

  // After the reconcile, so a module refused there adds nothing on its behalf.
  const peers = await addToolchainPeers(dir, name, retryCommand(args, { command: "marketplace install" }).command);
  await reportNextStep(dir, name);
  reportSync(sync, args.json);
  // Last, once the project holds everything the module brought: its section
  // of the route manifest lands now, not at the next `xano:routes`, so
  // `xano:check` is green straight after the install.
  const routes = await refreshRoutesAfterInstall(dir);

  if (isMachineOutput(args)) {
    writeJson({
      installed: pkg,
      alreadyInstalled,
      legacyPeerDeps: installed !== null && installed.peerConflict !== null,
      modules: sync.modules,
      unconfigured: sync.unconfigured,
      written: sync.written,
      changed: sync.changed || peers.length > 0 || routes === "written",
      peers,
      routes,
    });
  }
}

/** Whether `name`'s recorded dependency is the `file:` directory `spec` names. */
function sameLocalSource(dir: string, spec: string, manifest: Record<string, unknown> | null, name: string): boolean {
  const path = localPathOf(spec);
  if (path === undefined || manifest === null) return false;
  for (const block of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const range = (manifest[block] as Record<string, unknown> | undefined)?.[name];
    if (typeof range === "string" && range.startsWith("file:")) return resolve(dir, range.slice(5)) === resolve(dir, path);
  }
  return false;
}

/**
 * ── `xanosdk marketplace reinstall <package>` ─────────────────────────────────
 *
 * Re-ask one module its questions and reconcile, offering the project's CURRENT
 * settings as the defaults. That last part is not this file's work: a
 * module maps its own stored config back to answers (`answersFromConfig`), the
 * questionnaire seeds both the prompt default and the non-interactive fallback
 * from what it reads, and `ask: "package"` puts the questions to this module
 * alone. What this command owns is the four things that must be said BEFORE
 * any of that runs, because each one is a different mistake with a
 * different way out:
 *
 *   1. NOT A DEPENDENCY — refused before npm, so a typo never installs.
 *   2. Depended on but NOT INSTALLED — the tree, not the settings, is broken.
 *   3. NOT A TOOLCHAIN MODULE — there are no questions to re-ask at all.
 *   4. `enabled: false` — the one that would otherwise be a silent no-op.
 *
 * The fourth is why this command reads the config block itself. Discovery skips
 * a disabled module BEFORE IMPORTING IT, so a reconcile would find nothing to
 * ask and report success having done nothing. Asking a module its questions is
 * asking whether the project wants it, so the only coherent reading of
 * `reinstall` on a disabled module is "turn it back on and ask" — which it
 * does, and says so first. Answering no to the module's own enabling question
 * turns it straight back off, and the reconciler records that rather than
 * deleting the block.
 *
 * npm runs before every check but the dependency one and an early (3) — a
 * package already on disk that is plainly not a toolchain module — so the verb
 * also repairs a half-installed module rather than refusing to work on one,
 * and never runs npm for a package it is certain to refuse.
 */
export async function runMarketplaceReinstallCommand(args: ParsedArgs): Promise<void> {
  const opened = openVerb(args, "reinstall");
  const dir = opened.dir;
  // The name `install` took means the same package here: `reinstall auth`
  // re-asks the `@xano-sdk/auth` that `install auth` added.
  const { pkg, listing } = await resolveProjectModuleListing(opened.pkg, dir);
  // A name neither the project nor the catalogue knows: not found (exit 8), as
  // `install` and `details` answer the same name.
  if (listing === "unlisted") throw await unlistedModuleError("xanosdk marketplace reinstall", pkg);

  // (1) Before the spawn. `reinstall` takes a package the project ALREADY has,
  // so a name that is not in `dependencies` is a different verb's job — and
  // installing it here would be this command quietly becoming `install`.
  assertDependency(dir, pkg, listing);
  // (3), early: a package already on disk that is not a toolchain module has
  // no questions whatever npm does, so npm has nothing to repair for it.
  const onDisk = classifyInstalled(dir, pkg);
  if (onDisk === "workspace" || onDisk === "ordinary") refuseNotReaskable(dir, pkg, onDisk);
  // The module's questions are readable before npm when it is on disk; a
  // half-installed one is asked after npm repairs it, still before `Reinstalled`.
  if (onDisk !== "absent") await refuseUnclaimedFlags(args, dir, "reinstall", { enable: pkg });

  await install(pkg, dir, "reinstall", retryCommand(args, { command: "marketplace reinstall" }).command);
  if (onDisk === "absent") await refuseUnclaimedFlags(args, dir, "reinstall", { enable: pkg });
  // The module predates this run, so the refusal reports rather than removes.
  await assertInstalledSdkPeer(pkg, dir, { undo: false, verb: "reinstall" });

  // (2) and (3): what npm actually left on disk — decided before the success
  // line, so a refusal is never preceded by a claim that the reinstall worked.
  const declared = await assertReaskable(dir, pkg);
  blank();
  success(`Reinstalled ${pkg}.`);
  // (4): say it, then do it — before the questionnaire, so the sentence
  // explains the prompts that follow rather than a change already made.
  const disabled = announceReEnable(pkg, declared.config);
  await reportMissingInverse(pkg, declared);

  const { syncContributions } = await import("./sync-contributions.js");
  const sync = await syncContributions(dir, {
    apply: true,
    ask: "package",
    pkg,
    host: "reinstall",
    // The re-enabling, as a pending change rather than a write already made.
    // Discovery folds it in before deciding what to import, so the flag and
    // everything the re-ask settles land in the reconciler's ONE write — and a
    // refusal leaves the module exactly as switched off as it was.
    ...(disabled ? { enable: [pkg] } : {}),
    json: args.json,
    // The same obligation `install` carries: the parser deferred the check on
    // this verb, it did not cancel it. Whatever no question of this module's
    // claims is refused by name, naming `marketplace reinstall`.
    unknownFlags: args.unknownFlags,
  });

  // The same two steps `install` ends with: a module installed by hand under a
  // manager that does not add peers gets them here.
  const peers = await addToolchainPeers(dir, pkg, retryCommand(args, { command: "marketplace reinstall" }).command);
  reportSync(sync, args.json);
  const routes = await refreshRoutesAfterInstall(dir);

  if (isMachineOutput(args)) {
    const mod = sync.modules.find((m) => m.pkg === pkg);
    writeJson({
      reinstalled: pkg,
      modules: sync.modules,
      unconfigured: sync.unconfigured,
      written: sync.written,
      changed: sync.changed || peers.length > 0 || routes === "written",
      peers,
      routes,
      ...(mod?.sources === undefined ? {} : { sources: mod.sources }),
      // Hoisted alongside `sources` for the same reason it is: this verb is
      // ABOUT one package, so its caller should not have to find it in the
      // table. Names the flag that answers each question, which a caller
      // cannot derive from the ids `sources` is keyed by.
      ...(mod?.flags === undefined ? {} : { flags: mod.flags }),
    });
  }
}

/**
 * Refuse the flags no installed module's question claims — the check the
 * reconcile makes, made before this run writes or announces anything.
 *
 * The parser defers unknown flags on `install` and `reinstall` because a
 * module's question flags are unknowable until the module is on disk. That
 * deferral must not let a typo cost an npm run followed by `✓ Installed` and a
 * refusal. Every enabled module on disk is read, so this is never stricter than
 * the reconcile; whatever it lets through, the reconcile still refuses.
 *
 * `undo` names a package THIS run added, uninstalled again before the refusal
 * so the project is exactly as it was.
 */
async function refuseUnclaimedFlags(
  args: ParsedArgs,
  dir: string,
  verb: "install" | "reinstall",
  opts: { readonly undo?: string; readonly enable?: string } = {},
): Promise<void> {
  if (args.unknownFlags.length === 0) return;
  const { undo, enable } = opts;
  const [{ discoverToolchainPlugins }, { questionSets, flagFor, hostHelpTarget }] = await Promise.all([
    import("./toolchain-modules.js"),
    import("./plugin-questions.js"),
  ]);
  let flags: string[];
  try {
    // `reinstall` switches a disabled module back on before asking it, so its
    // flags are claimable here too.
    const { loaded } = await discoverToolchainPlugins(dir, {
      frozen: false,
      configuring: true,
      // As the reconcile discovers, so this is never stricter than it.
      peerSkew: "skip",
      ...(enable === undefined ? {} : { configOverride: { [enable]: { enabled: true } } }),
    });
    flags = questionSets(loaded).flatMap((set) => set.questions.map(flagFor));
  } catch {
    // Discovery's own refusal is the reconcile's to report, in its words.
    return;
  }
  const claimable = (arg: string): boolean => {
    if (!arg.startsWith("--")) return false;
    const name = arg.slice(2).split("=", 1)[0]!;
    return flags.some((f) => name === f || name === `no-${f}`);
  };
  const unclaimed = args.unknownFlags.filter((arg) => !claimable(arg));
  if (unclaimed.length === 0) return;
  let undone = false;
  if (undo !== undefined) {
    try {
      await uninstall(undo, dir);
      undone = true;
    } catch {
      // npm printed its reason; the refusal below says the package stayed.
    }
  }
  const err = unknownFlag(unclaimed, hostHelpTarget(verb), flags);
  if (undo !== undefined) {
    err.message += undone
      ? `\n  ${undo} was uninstalled again, so this project is exactly as it was.`
      : `\n  ${undo} is still installed: run \`xanosdk marketplace remove ${undo}\` to drop it.`;
  }
  throw err;
}

/**
 * Whether the project depends on `pkg` by name.
 *
 * Derived from {@link declaredDependencies} rather than reading the dependency
 * maps again: `reinstall` refuses a package this says no about, and the
 * reconciler DELETES what it says no about, so the two answering differently is
 * the one disagreement these verbs cannot survive.
 */
function isDependency(manifest: Record<string, unknown>, pkg: string): boolean {
  return declaredDependencies(manifest).includes(pkg);
}

/** Whether this project depends on `pkg` or records settings for it — what `remove` could act on. */
function inProject(dir: string, pkg: string): boolean {
  const manifest = readProjectManifest(dir);
  return (manifest !== null && isDependency(manifest, pkg)) || pkg in readToolchainBlock(dir, manifest);
}

/**
 * The modules this project has: every dependency whose installed manifest
 * carries a `"xanosdk"` field, and every package it records settings for. Read
 * off disk, no network — a `remove` slip's candidates.
 */
function installedModules(dir: string): string[] {
  const manifest = readProjectManifest(dir);
  const modules = (manifest === null ? [] : declaredDependencies(manifest)).filter((pkg) => {
    const state = readInstalledManifestState(dir, pkg);
    const field = state.kind === "ok" ? state.manifest["xanosdk"] : undefined;
    return typeof field === "object" && field !== null;
  });
  return [...new Set([...modules, ...Object.keys(readToolchainBlock(dir, manifest))])];
}

/**
 * What an installed package IS, as far as this project can tell — one reading,
 * used by every verb that has to decide.
 *
 * Four answers, and each one sends a verb somewhere different:
 *
 * - `absent` — not in `node_modules`, or its `package.json` does not parse.
 *   Nothing here can say what it was; npm owns the remedy.
 * - `toolchain` / `workspace` — a module of ours, of one kind or the other.
 * - `ordinary` — an npm package with no `"xanosdk"` field, or one whose `kind`
 *   we do not recognize.
 *
 * The classification itself is the loaders' own ({@link moduleKind}), never a
 * second one invented here — and the fan-out AROUND it is written once too. Three
 * copies drift: if only the epilogue caught the `UsageError` `moduleKind` throws
 * on an unrecognized `kind`, the REFUSAL paths would let it escape and report a
 * module author's typo as this command failing.
 *
 * So the throw is decided once, here, and REPORTED rather than propagated. By
 * the time any caller asks, npm has already run and the project's manifest is
 * already mutated; throwing would report completed work as failed, and the
 * remedy — a typo in the MODULE's own manifest — is not this command's to make.
 *
 * Each verb keeps its own message strings. What to SAY about a workspace module
 * genuinely differs between `install`, `reinstall` and `remove`; what one IS
 * does not.
 */
type InstalledClass = "absent" | "toolchain" | "workspace" | "ordinary";

function classifyInstalled(dir: string, pkg: string): InstalledClass {
  const state = readInstalledManifestState(dir, pkg);
  if (state.kind !== "ok") return "absent";
  // No `"xanosdk"` field at all: not one of ours in either sense.
  const field = state.manifest["xanosdk"];
  if (typeof field !== "object" || field === null) return "ordinary";
  try {
    return moduleKind(pkg, state.manifest);
  } catch (error) {
    warn(
      `${pkg} does not declare a module kind we recognize, so it is read as an ordinary package.`,
      "module.kind-unknown",
      [error instanceof Error ? error.message : String(error)],
    );
    return "ordinary";
  }
}

/** Whether the installed `pkg` carries a `"xanosdk"` field at all — an unrecognized kind included. */
function hasXanoSdkField(dir: string, pkg: string): boolean {
  const state = readInstalledManifestState(dir, pkg);
  return state.kind === "ok" && typeof state.manifest["xanosdk"] === "object" && state.manifest["xanosdk"] !== null;
}

/**
 * A refusal of what this project holds: the arguments parsed, and the state
 * said no. The next step rides in the message itself — no help block under it,
 * which lists flags that were never the problem, and no "Did you mean:", which
 * reads an instruction as a misspelling.
 */
function refusal(message: string, next: string): UsageError {
  return new UsageError(`${message} ${next}`);
}

/** Refusal 1 — and the only one that runs before npm does. */
function assertDependency(dir: string, pkg: string, listing: ProjectModuleListing): void {
  const manifest = readProjectManifest(dir);
  if (manifest !== null && isDependency(manifest, pkg)) return;
  throw refusal(
    `\`xanosdk marketplace reinstall\`: ${pkg} is not a dependency of this project, so there are no settings to re-ask.`,
    // `install` is the next step only for a name it would install — a module
    // the catalogue lists. Anything else it refuses too (exit 8).
    listing === "catalogue" || listing === "project"
      ? `Run \`xanosdk marketplace install ${pkg}\` to add it.`
      : `Check the name — \`xanosdk marketplace list\` shows what is published.`,
  );
}

/**
 * Refusals 2 and 3 — read after npm, because npm is what makes the
 * difference between them and a working install.
 *
 * Returns the module's declaration on success, so the caller reads the
 * classification the loaders themselves made rather than a second one.
 */
async function assertReaskable(dir: string, pkg: string): Promise<DeclaredPlugin> {
  const { declaredToolchainPlugins } = await import("./toolchain-modules.js");
  const declared = declaredToolchainPlugins(dir).find((d) => d.pkg === pkg);
  if (declared !== undefined && declared.unreadable === undefined) return declared;

  const installed = classifyInstalled(dir, pkg);
  if (installed === "absent") {
    // (2) Depended on, not on disk. npm has already run and did not fix it, so
    // the remedy is the tree, not this command.
    throw refusal(
      `\`xanosdk marketplace reinstall\`: ${pkg} is a dependency but is not installed, so its questions cannot be read.`,
      `Run \`${installCommandFor(dir)}\` to restore node_modules, then re-run this command.`,
    );
  }
  // (3) Installed and readable, but nothing here asks questions.
  return refuseNotReaskable(dir, pkg, installed === "workspace" ? "workspace" : "ordinary");
}

/**
 * Refusal 3. Two shapes, two different next steps — a workspace module is
 * registered in code, and an ordinary package has no Xano SDK settings at all.
 */
function refuseNotReaskable(dir: string, pkg: string, installed: "workspace" | "ordinary"): never {
  const workspace = installed === "workspace";
  // A module the backend already imports needs no wiring: the remedy is an update.
  const importers = workspace ? backendImporters(dir, pkg) : [];
  throw refusal(
    workspace
      ? `\`xanosdk marketplace reinstall\`: ${pkg} is a workspace module, not a toolchain module — it contributes no project settings to re-ask.`
      : `\`xanosdk marketplace reinstall\`: ${pkg} is an ordinary npm package, not a Xano SDK toolchain module, so it has no questions to re-ask.`,
    !workspace
      ? `Run \`${addCommandFor(dir, pkg)}\` to update it.`
      : importers.length > 0
        ? `It is already imported in ${importers.join(", ")}; run \`${addCommandFor(dir, pkg)}\` to update it.`
        : `Import it in \`xano/index.ts\` and register it onto your workspace.`,
  );
}

/**
 * Refusal 4 — the one that refuses to be a no-op instead of refusing to
 * run.
 *
 * A module recorded `enabled: false` is never imported, so the reconcile that
 * follows would ask nothing and write nothing and still look like it worked.
 * This says so out loud, because re-enabling something the project deliberately
 * turned off is not a detail — and says it BEFORE the questionnaire, so the
 * sentence explains the prompts that follow rather than a change already made.
 *
 * ── It announces; it does not write ────────────────────────────────────────
 *
 * The flag travels to the reconciler as `SyncOptions.enable`, which hands it to
 * discovery IN MEMORY. Discovery decides what to import by reading `enabled`
 * off disk, so the flag has to be true before the reconcile starts — but
 * WRITING it first to achieve that put it outside the reconciler's
 * all-or-nothing write, and a reconcile that then refused (an unknown flag,
 * another module's contract skew) left the module ENABLED: a state nobody asked
 * for, produced by a run that reported failure.
 *
 * Handing discovery the pending flag satisfies the same requirement with no
 * write at all. The flag and everything the re-ask settles are recorded by one
 * write, so a refusal leaves the module exactly as switched off as it was.
 *
 * Every other setting the block holds survives, so a module with an inverse
 * still offers the project's chosen values as the prompt defaults.
 *
 * Returns whether the module was in fact switched off.
 */
function announceReEnable(pkg: string, config: Readonly<Record<string, unknown>> | null): boolean {
  if (config?.["enabled"] !== false) return false;
  warn(
    `${pkg} is switched off in this project (\`"enabled": false\`).`,
    "module.disabled",
    [
      `Re-enabling it, because re-asking a module its questions is asking whether you want it. ` +
        `Answer no to its enabling question to switch it straight back off.`,
    ],
  );
  return true;
}

/**
 * A re-ask offers the project's current settings — stated rather than assumed
 * here: a module with no `answersFromConfig` cannot have its stored settings
 * read back, so the re-ask starts from the defaults it ships rather than from
 * what this project chose.
 *
 * Silent, that is the one outcome of `reinstall` that could lose a setting
 * without anyone seeing it happen — accept every prompt and a chosen directory
 * reverts to the module's own. Read by importing the plugin file directly:
 * Node caches the URL, so the reconcile's own import of it costs nothing more.
 */
async function reportMissingInverse(pkg: string, declared: DeclaredPlugin): Promise<void> {
  // Nothing stored means nothing to read back, and a module is free to ship no
  // questions at all — neither is worth a sentence.
  if (declared.pluginFile === null) return;
  if (declared.config === null || Object.keys(declared.config).length === 0) return;
  const { loadFile } = await import("./module-manifest.js");
  const loaded = await loadFile(declared.pluginFile);
  // A plugin that will not import is the reconciler's to report, not this
  // courtesy's to duplicate.
  if (loaded.kind !== "loaded") return;
  const plugin = loaded.exports["default"];
  if (typeof plugin !== "object" || plugin === null) return;
  const shape = plugin as { questions?: unknown[]; answersFromConfig?: unknown };
  if ((shape.questions?.length ?? 0) === 0) return;
  if (typeof shape.answersFromConfig === "function") return;
  detail(
    `${pkg} does not map its stored settings back to answers, so the questions below start ` +
      `from the defaults it ships rather than from this project's current settings.`,
  );
}

/**
 * ── `xanosdk marketplace remove <package>` ────────────────────────────────────
 *
 * Uninstall, then reconcile — and the ORDER is the whole design.
 *
 * Removing a module by hand is not the same thing, and the leftover is not
 * cosmetic. The package goes; the project's `"xanosdk"` block does not. While
 * the dependency is still declared and the module is not on disk — `npm
 * uninstall --no-save`, a deleted `node_modules/<pkg>`, a half-finished
 * install, a lockfile that drifted — `configuredPackages` still names it, so
 * `declaredToolchainPlugins` synthesizes a configured-but-not-installed entry
 * and `reportSkipped` under `--frozen-lock` THROWS on it: every frozen run
 * fails until someone hand-edits `package.json`. Once the dependency is gone
 * too, the block is stale settings nothing else cleans up. This verb prevents
 * both states, and (see below) repairs both.
 *
 * npm runs FIRST because the reconciler derives removal from `dependencies`:
 * a package is dropped exactly when the project still configures it and
 * no longer depends on it, so the block can only go once the dependency has.
 * The inverse order is worse than useless — dropping the config while the
 * package is still installed leaves it ENABLED WITH NO SETTINGS, because
 * `isEnabled(null)` is true.
 *
 * A FAILED uninstall therefore costs nothing: the dependency is still there,
 * so a reconcile would derive no removal at all, and the project is byte-for-
 * byte what it was. Nothing is reconciled on that path anyway — the throw says
 * so out loud, because "npm failed" alone leaves a reader wondering whether
 * they are now half-removed.
 *
 * ── The half-removed project is a first-class input ─────────────────────────
 *
 * A package that is NOT a dependency but IS still configured is not a refusal —
 * it is the repair. npm is skipped (there is nothing to uninstall) and the
 * reconcile does the rest.
 *
 * Note which half-removed state sends the reader here. The frozen message only
 * fires while the dependency is still DECLARED, because
 * `declaredToolchainPlugins` iterates `declaredDependencies` and synthesizes
 * the configured-but-not-installed entry inside that loop. A plain (saving)
 * `npm uninstall` takes the name out of `dependencies`, so nothing reports the
 * leftover at all and no frozen run fails: the block is stale settings that
 * only this verb, or the next install/reinstall, cleans up. Telling the reader
 * the leftover fails their CI would promise a guard that is not running.
 *
 * ── Three refusals, each a different mistake ────────────────────────────────
 *
 * All three run BEFORE npm, because each is decided from what is on disk now
 * and every one of them means the uninstall should not happen.
 *
 *   1. NOT A MODULE THIS VERB CAN REMOVE — three shapes, each with its own
 *      message: a workspace module the backend still imports (drop the import
 *      first; one nothing imports is simply uninstalled, the inverse of its
 *      install), an ordinary package, and a dependency that is not installed
 *      at all, where nothing on disk can say what it once was.
 *   2. Neither a dependency NOR configured — nothing to remove at all.
 *   3. `enabled: false` — switched off is not removed. It is still installed
 *      and still in `dependencies`, and a module parked deliberately is not one
 *      to delete on a guess.
 *
 * What this verb does NOT do is offer to delete a directory the module
 * generated. That is the module's data, the contract names no such directory,
 * and a removal that deletes rendered source is not a removal anyone can undo.
 */
export async function runMarketplaceRemoveCommand(args: ParsedArgs): Promise<void> {
  const opened = openVerb(args, "remove");
  const dir = opened.dir;
  // The same resolution `install` used, so `remove auth` removes `@xano-sdk/auth`.
  const { pkg, listing } = await resolveProjectModuleListing(opened.pkg, dir);
  // A module this project does not have is already removed — the state
  // `remove` exists to reach — so a second `remove` succeeds and says so
  // (exit 0, `alreadyGone: true`) rather than failing a retried script. Whether
  // the catalogue lists the name does not change that: `remove authh` exited 8
  // (suggesting `auth`, which was not installed either) where `remove auth`
  // exited 0 (E2E pass 27). A slip is caught against what IS installed — the
  // only names this verb can act on.
  if (listing === "catalogue" || listing === "unlisted" || (listing === "unknown" && !inProject(dir, pkg))) {
    success(`${pkg} is not installed in this project — nothing to remove.`);
    const near = nearPackage(opened.pkg, installedModules(dir));
    if (near !== undefined) {
      detail(
        `Did you mean \`${near.hit}\`${near.pkg === near.hit ? "" : ` (${near.pkg})`}? It is installed: ` +
          `\`xanosdk marketplace remove ${near.hit}\`.`,
      );
    }
    // What an earlier removal left is still reported: a lock that still pins
    // the module's objects said `lockOrphans: 0` on the repeat, while the
    // prune it needs was still owed. Read, never inferred.
    const followUp = await afterWorkspaceModuleRemoved(dir);
    // The same keys a removal that did something reports, so a script reads
    // one shape whatever the state was.
    if (isMachineOutput(args)) {
      writeJson({
        removed: pkg,
        alreadyGone: true,
        droppedConfig: false,
        modules: [],
        unconfigured: [],
        written: [],
        changed: followUp.routes === "written",
        routes: followUp.routes,
        lockOrphans: followUp.lockOrphans,
        ...(near === undefined ? {} : { suggestion: near.hit }),
      });
    }
    return;
  }

  const target = await assertRemovable(dir, pkg, args.json === true ? " --json" : "");

  if (target.dependency) {
    await uninstall(pkg, dir, retryCommand(args, { command: "marketplace remove" }).command);
    blank();
    success(`Uninstalled ${pkg}.`);
  } else {
    // The repair path. Said plainly: a reader who typed `remove` after already
    // running `npm uninstall` needs to know why npm did not run again.
    blank();
    warn(
      `${pkg} is no longer a dependency, but this project still records settings for it.`,
      "module.stale-settings",
      [`Nothing to uninstall — dropping what was left behind, which nothing else reports.`],
    );
  }

  // The same reconciler, with the same removal rule: a writing pass that asks
  // nobody. Not `"unanswered"`, which would stop to interrogate every OTHER
  // module the project has never configured in the middle of a removal.
  //
  // This is the call that needed the two dials separated. While one mode meant
  // both, it had to say `ask: "package"` naming the package it had just
  // uninstalled, and lean on the ask-set coming out empty because discovery
  // could no longer find it — correct by arithmetic rather than by saying what
  // it meant, and one restored `node_modules` away from asking.
  const { syncContributions } = await import("./sync-contributions.js");
  const sync = await syncContributions(dir, {
    apply: true,
    ask: "none",
    host: "remove",
    json: args.json,
  });

  reportSync(sync, args.json);
  // DERIVED from what the reconcile actually dropped, never asserted — and only
  // TRUE because removal now covers marked BLOCKS as well as config entries.
  // While it read the config block alone, a package whose entry had been
  // hand-deleted (which is what this command's own disabled-module refusal
  // tells people to do) still owned a span of `.gitattributes`, and this line
  // said the opposite.
  if (!sync.removed.includes(pkg) && !target.workspace) {
    detail(`No settings or file lines were recorded for ${pkg}, so there was nothing else to drop.`);
  }

  // A workspace module took its objects with it: the committed route manifest
  // still lists its endpoints, and the lock still pins its identities. The
  // manifest is brought up to date here; the lock entries are named with the
  // prune that drops them, since a pruned canonical cannot be recovered.
  // Every removal reports the lock as it really is — a toolchain module owns no
  // objects, but an earlier removal may have left orphans the prune still owes.
  const followUp = await afterWorkspaceModuleRemoved(dir);

  if (isMachineOutput(args)) {
    writeJson({
      removed: pkg,
      alreadyGone: false,
      droppedConfig: sync.removed.includes(pkg),
      modules: sync.modules,
      unconfigured: sync.unconfigured,
      written: sync.written,
      // `npm uninstall` rewrote package.json even when the reconcile had nothing to do.
      changed: sync.changed || target.dependency || followUp.routes === "written",
      routes: followUp.routes,
      lockOrphans: followUp.lockOrphans,
    });
  }
}

/** What a removal found, once every refusal has been ruled out. */
interface RemovalTarget {
  /** Whether npm has anything to uninstall, or the dependency is already gone. */
  readonly dependency: boolean;
  /** A workspace module: its objects leave the backend with it. */
  readonly workspace?: boolean;
}

/** What a marketplace verb did to the project's `routes.gen.ts`. */
type RoutesRefresh = RouteManifestRefresh["manifest"];

/**
 * After a workspace module is removed: regenerate the route manifest if the
 * project keeps one, and name the lock entries the workspace no longer exports
 * with the prune that drops them. Never fatal — the removal is done; what
 * cannot be brought up to date here is said with the command that does it.
 */
async function afterWorkspaceModuleRemoved(dir: string): Promise<{ routes: RoutesRefresh; lockOrphans: number }> {
  const { rel, routes, lockOrphans } = await refreshProjectRoutes(dir, {
    regenerated: "without the removed module's endpoints",
    loading: "update what the module left behind",
    remedy: (rel) => `Run \`npm run xano:routes\` and \`xanosdk lock prune ./${rel}/index.ts --yes\` once it loads.`,
  });
  if (lockOrphans > 0) {
    warn(
      `${rel}/xano.lock still pins ${lockOrphans} ${lockOrphans === 1 ? "entry" : "entries"} the workspace no longer exports ` +
        `(the removed module's objects). Once they are gone for good: \`xanosdk lock prune ./${rel}/index.ts --yes\`.`,
      "lock.module-orphans",
    );
  }
  return { routes, lockOrphans };
}

/**
 * After `install` or `reinstall`: bring the route manifest up to date, so a
 * toolchain module's section lands with the module. Only a project that keeps
 * a manifest beside its entry — the same file `remove` refreshes; one with no
 * `routes.gen.ts` gets none from an install, and its entry is not loaded.
 */
async function refreshRoutesAfterInstall(dir: string): Promise<RoutesRefresh> {
  if (!existsSync(join(backendDirIn(dir), "routes.gen.ts"))) return "absent";
  const { routes } = await refreshProjectRoutes(dir, {
    regenerated: "for the modules now installed",
    loading: "refresh routes.gen.ts",
    remedy: () => "Run `npm run xano:routes` once it loads.",
  });
  return routes;
}

/**
 * The refresh `install`, `reinstall` and `remove` share: regenerate the
 * project's `routes.gen.ts` and say what happened. Never fatal — the package
 * change is done; what cannot be refreshed here is said with the command that
 * does it.
 *
 * Two different failures, two different warnings. An entry that will not load
 * is `module.load-failed`, with the caller's remedy. A manifest that cannot be
 * written (an unresolved api group, or a module block that cannot be carried
 * forward) is `routes.not-written`, naming the reason: the entry loaded fine,
 * and blaming it sends the reader to the wrong file.
 */
async function refreshProjectRoutes(
  dir: string,
  say: {
    /** What a regenerated file now reflects, after "Regenerated <file>". */
    readonly regenerated: string;
    /** What loading the entry was for, after "Could not load <entry> to". */
    readonly loading: string;
    /** What to run once the entry loads, given the backend's relative path. */
    readonly remedy: (rel: string) => string;
  },
): Promise<{ rel: string; routes: RoutesRefresh; lockOrphans: number }> {
  const backend = backendDirIn(dir);
  const entry = join(backend, "index.ts");
  const rel = relForwardSlash(dir, backend) || ".";
  if (!existsSync(entry)) return { rel, routes: "absent", lockOrphans: 0 };
  let refreshed: RouteManifestRefresh;
  try {
    const { refreshRouteManifest } = await import("./cli.js");
    refreshed = await refreshRouteManifest(entry, join(backend, "routes.gen.ts"), dir);
  } catch (err) {
    warn(
      `Could not load ${rel}/index.ts to ${say.loading} ` +
        `(${err instanceof Error ? err.message.split("\n")[0] : String(err)}). ${say.remedy(rel)}`,
      "module.load-failed",
    );
    return { rel, routes: "skipped", lockOrphans: 0 };
  }
  const { manifest, lockOrphans, why } = refreshed;
  if (manifest === "written") info(`Regenerated ${rel}/routes.gen.ts ${say.regenerated}.`);
  if (manifest === "skipped") {
    // With a `why`, the block it names fails `xano:routes` the same way, so the
    // reason's own remedy (a hand edit) is the one to give.
    warn(
      why === undefined
        ? `${rel}/routes.gen.ts could not be regenerated here — run \`npm run xano:routes\` and commit it.`
        : `${rel}/routes.gen.ts could not be regenerated here: ${why}`,
      "routes.not-written",
    );
  }
  return { rel, routes: manifest, lockOrphans };
}

/**
 * The refusals for `remove` — every one before npm touches anything.
 *
 * The classification is the loaders' own (`declaredToolchainPlugins`,
 * `moduleKind`), never a second one invented here, so `remove` and the frozen
 * guard can never disagree about what a package is. A dependency the loaders
 * DECLARE is removable even when it is not on disk: that is the
 * configured-but-absent entry the frozen guard refuses, and refusing to remove
 * it would leave the one project that most needs this verb with no way out.
 */
async function assertRemovable(
  dir: string,
  pkg: string,
  /** This run's output flag, kept on the re-run a refusal prints. */
  outputFlag = "",
): Promise<RemovalTarget> {
  const manifest = readProjectManifest(dir);
  const dependency = manifest !== null && isDependency(manifest, pkg);
  const configured = pkg in readToolchainBlock(dir, manifest);

  // (2) Nothing by this name in either place. Usually a typo, and there is no
  // state to repair either way.
  if (!dependency && !configured) {
    throw refusal(
      `\`xanosdk marketplace remove\`: ${pkg} is not a dependency of this project and this project records no settings for it, so there is nothing to remove.`,
      `Check the name — \`xanosdk marketplace list\` shows what is published.`,
    );
  }

  const { declaredToolchainPlugins } = await import("./toolchain-modules.js");
  const declared = declaredToolchainPlugins(dir).find((d) => d.pkg === pkg);

  // (3) Switched off, which is a state the project chose and is not this state.
  if (declared?.config?.["enabled"] === false) {
    throw refusal(
      `\`xanosdk marketplace remove\`: ${pkg} is switched off in this project (\`"enabled": false\`), which is not the same as removed — it is still installed and still in dependencies.`,
      `Run \`xanosdk marketplace reinstall ${pkg}\` to switch it back on if you still want it, or delete its ` +
        `entry from this project's package.json "xanosdk" block and re-run this command to drop it for good.`,
    );
  }

  // Declared by the loaders, or still configured as one: removable either way.
  if (declared !== undefined || !dependency) return { dependency };

  // (1) A dependency that is not one of ours, in one of three shapes.
  const installed = classifyInstalled(dir, pkg);
  if (installed === "absent") {
    // Not on disk and not configured, so nothing ever read its settings and
    // nothing here can tell what it was. npm owns the whole job.
    throw refusal(
      `\`xanosdk marketplace remove\`: ${pkg} is a dependency but is not installed, so there is no way to tell whether it contributed anything to remove.`,
      `Run \`${removeCommandFor(dir, pkg)}\` — this project records no Xano SDK settings for it.`,
    );
  }
  if (installed === "workspace") {
    // A workspace module is removed the way it was installed — npm, and nothing
    // else, since it contributed no settings. What it DOES leave is code: the
    // backend imports and registers it, and uninstalling under that import
    // breaks the next export. So the import is the refusal, named by file.
    const importers = backendImporters(dir, pkg);
    if (importers.length > 0) {
      throw refusal(
        `\`xanosdk marketplace remove\`: ${pkg} is a workspace module your backend still imports ` +
          `(${importers.join(", ")}), so uninstalling it would break the next export.`,
        `Drop its import and registration from ${importers.length === 1 ? "that file" : "those files"}, ` +
          `then re-run \`xanosdk marketplace remove ${pkg}${outputFlag}\`.`,
      );
    }
    return { dependency, workspace: true };
  }
  // It contributed no settings, but the backend may still import it (init wires
  // a package that declares no \`xanosdk\` field by its \`register*\` export), and
  // uninstalling under that import breaks the next export.
  const importers = backendImporters(dir, pkg);
  throw refusal(
    `\`xanosdk marketplace remove\`: ${pkg} is an ordinary npm package, not a Xano SDK module, so it contributed nothing this command would reconcile` +
      (importers.length > 0 ? ` — but your backend imports it (${importers.join(", ")}).` : `.`),
    importers.length > 0
      ? `Drop its import and registration from ${importers.length === 1 ? "that file" : "those files"}, then run \`${removeCommandFor(dir, pkg)}\`.`
      : `Run \`${removeCommandFor(dir, pkg)}\`.`,
  );
}

/** Source extensions a backend imports a module from. */
const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

/** Each backend source file, relative to the project, with its comments blanked. */
function backendSources(dir: string): { rel: string; code: string }[] {
  const found: { rel: string; code: string }[] = [];
  const walk = (at: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
        try {
          found.push({ rel: relForwardSlash(dir, full), code: withoutComments(readFileSync(full, "utf8")) });
        } catch {
          // Unreadable: nothing here can say what it imports.
        }
      }
    }
  };
  walk(backendDirIn(dir));
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Matches a quoted import specifier naming `pkg` or a subpath of it. */
function specifierOf(pkg: string): RegExp {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`["'\`]${escaped}(?:/[^"'\`]*)?["'\`]`);
}

/**
 * The backend source files that import `pkg` (or a subpath of it), relative to
 * the project. A textual read over code (comments blanked), not a module graph:
 * an import is a quoted specifier, and a false positive costs one refusal whose
 * message names the file to look at — never a removed package the backend
 * still needs.
 */
function backendImporters(dir: string, pkg: string): string[] {
  const specifier = specifierOf(pkg);
  return backendSources(dir)
    .filter((file) => specifier.test(file.code))
    .map((file) => file.rel);
}

/**
 * The relative specifiers `code` (comments blanked) imports, re-exports or
 * requires. A type-only `import type …` / `export type …` loads nothing at
 * runtime, so the file it names is not reached through it.
 */
function relativeSpecifiers(code: string): string[] {
  const found: string[] = [];
  const valueCode = code.replace(/(?<![\w$.])(?:import|export)\s+type\s+(?!from\b)[^;]*?\bfrom\s*(["'`])[^"'`\n]*\1/g, "");
  for (const m of valueCode.matchAll(/(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*(["'`])(\.{1,2}\/[^"'`\n]*)\1/g)) found.push(m[2]!);
  return found;
}

/** The file a relative specifier names: as written, its `.js`-family twin in TypeScript, an extension added, or a directory's index. */
function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const twin = base.replace(/\.([cm]?)js(x?)$/, ".$1ts$2");
  const exts = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  const candidates = [base, twin, ...exts.map((e) => base + e), ...exts.map((e) => join(base, `index${e}`))];
  for (const candidate of candidates) {
    if (candidate.split(/[\\/]/).includes("node_modules")) continue;
    try {
      if (statSync(candidate).isFile() && SOURCE_FILE.test(candidate)) return candidate;
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

/**
 * The backend files the project entry reaches through relative imports, the
 * entry first — what an export actually loads. `undefined` when there is no
 * entry to start from.
 */
function reachableSources(dir: string): { rel: string; code: string }[] | undefined {
  const entry = join(backendDirIn(dir), "index.ts");
  if (!existsSync(entry)) return undefined;
  const found: { rel: string; code: string }[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let code: string;
    try {
      code = withoutComments(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    found.push({ rel: relForwardSlash(dir, file), code });
    for (const specifier of relativeSpecifiers(code)) {
      const next = resolveRelative(file, specifier);
      if (next !== undefined) queue.push(next);
    }
  }
  return found;
}

/**
 * Whether the backend REGISTERS `pkg` — calls its `register` function — read
 * over the files the entry reaches (every backend file when there is no
 * entry), since importing one of its values (auth's `userTable` for chatbot)
 * registers nothing and a file nothing imports never runs. `unknown` names the
 * files that reach the module in a way the read cannot follow.
 */
function backendRegistration(dir: string, pkg: string, register: string): { registrars: string[]; unknown: string[] } {
  const registrars: string[] = [];
  const unknown: string[] = [];
  const files = reachableSources(dir) ?? backendSources(dir);
  for (const file of files) {
    const state = registerState(file.code, pkg, register);
    if (state === "yes") registrars.push(file.rel);
    else if (state === "unknown") {
      // A call inside an exported function registers once another file runs it.
      const wrappers = registerWrappers(file.code, pkg, register);
      const called = wrappers.length > 0 && files.some((other) => other !== file && callsImportedAtTop(other.code, wrappers));
      (called ? registrars : unknown).push(file.rel);
    }
  }
  return { registrars, unknown };
}

/**
 * `npm uninstall <pkg>`, captured behind the same spinner the install uses.
 *
 * No peer retry: `--legacy-peer-deps` is about what npm will ADD to a tree, and
 * removing a package resolves whatever it resolves.
 *
 * A FAILURE replays npm's own output verbatim and then throws — and the throw
 * says the project is UNCHANGED, which is the fact a reader actually needs. The
 * reconcile below never runs on this path, and it would derive nothing if it
 * did: the dependency is still declared, so the package is not in the removal
 * set at all. Re-running the command after fixing whatever npm complained about
 * is a complete repair, with nothing to undo first.
 */
async function uninstall(pkg: string, dir: string, rerun?: string): Promise<void> {
  const spin = spinner(`Uninstalling ${style.bold(pkg)}`);
  let result: RemoveOutcome;
  try {
    result = await removeDependency(dir, pkg, rerun);
  } finally {
    spin.stop();
  }
  const { manager } = result.site;
  const verb = removeArgs(manager, pkg)[0];
  if (result.status === 0 && !result.stillListed) return;

  process.stderr.write(terminalText(result.output.trimEnd()) + "\n");
  throw new Error(
    (result.status === 0
      ? `${manager} ${verb} ${pkg} exited 0, but this project's package.json still lists ${pkg}. `
      : `${manager} ${verb} ${pkg} failed (exit ${result.status}). `) +
      `Nothing was reconciled: ${pkg} is still a ` +
      `dependency, so this project's settings and file lines for it are exactly as they were. ` +
      `Fix what ${manager} reported and re-run \`xanosdk marketplace remove ${pkg}\`.`,
  );
}

/**
 * Refuse a module this SDK is outside the declared peer range of — AFTER npm,
 * and before anything is reconciled or reported as installed.
 *
 * ── Why npm's own refusal is not enough ─────────────────────────────────────
 *
 * npm DOES refuse this tree, and `installWithPeerRetry` then installs it anyway
 * with `--legacy-peer-deps`. That retry is not a bug to remove: npm excludes
 * prereleases from every range a module declares, so a PRERELEASE CLI fails
 * every module install for a reason that has nothing to do with the module.
 * The retry exists to rescue exactly that case, and it rescues the genuine
 * skew along with it.
 *
 * So the question is asked again here, by the SDK, using the reading that knows
 * the difference: {@link sdkPeerSkew} has no opinion on a prerelease CLI and no
 * opinion on a range it cannot parse, and reports only a version this SDK is
 * definitively outside of.
 *
 * ── Why it undoes the install rather than leaving it ────────────────────────
 *
 * Without this, npm's retry writes the module into `dependencies`, the command
 * says `Installed`, and the reconcile that follows refuses it — leaving a
 * project whose every module-loading command then fails until someone hand-
 * edits `package.json`. "Installed" followed by a broken project is a worse
 * outcome than a refusal, and the refusal is the honest one: the module does
 * not work here.
 *
 * `undo` is the caller's to decide, because it means "remove what THIS RUN
 * added". `install` adding a package the project did not have undoes it and
 * the project is exactly as it was. `reinstall`, and an `install` re-run over a
 * package already in `dependencies`, must not: the module predates the run, it
 * may be configured, and deleting a user's module over a version mismatch is
 * not a repair anyone asked for. Those refuse and say what state the project is
 * in instead.
 */
async function assertInstalledSdkPeer(
  pkg: string,
  dir: string,
  opts: { readonly undo: boolean; readonly verb: "install" | "reinstall" },
): Promise<void> {
  const [{ sdkPeerSkew }, { readVersion }, { readInstalledManifest }] = await Promise.all([
    import("./toolchain-modules.js"),
    import("./cli.js"),
    import("./module-manifest.js"),
  ]);
  const manifest = readInstalledManifest(dir, pkg);
  if (manifest === null) return;
  const undo = async (): Promise<boolean> => {
    if (!opts.undo) return false;
    try {
      await uninstall(pkg, dir);
      return true;
    } catch {
      // The refusal is the news, not the rollback's own failure — and npm has
      // already printed its reason. Reported as not-undone so the message
      // describes the project the reader actually has.
      return false;
    }
  };

  const sdkVersion = readVersion();
  const range = sdkPeerSkew(manifest, sdkVersion);
  if (range === null) return;

  const undone = await undo();

  throw refusal(
    `${pkg} requires \`@xano/sdk\` ${range}, and this is ${sdkVersion} — its hooks were built ` +
      `against a contract this SDK does not have, so it would register and apply nothing.`,
    undone
      ? `It was uninstalled again, so this project is exactly as it was. Upgrade with ` +
        `\`${addCommandFor(dir, "@xano/sdk@latest")}\` and re-run this command, or install a ${pkg} built ` +
        `for this SDK.`
      : `${pkg} is still installed and still a dependency, and every command that loads ` +
        `modules will refuse it until this is settled. Upgrade with ` +
        `\`${addCommandFor(dir, "@xano/sdk@latest")}\`, or run \`xanosdk marketplace remove ${pkg}\` to drop ` +
        `it and its settings together.`,
  );
}

/**
 * `npm install <pkg>`, with the peer retry every installer in this CLI shares.
 *
 * Captured rather than streamed, and that is what the retry costs: deciding
 * whether npm refused over a PEER RANGE needs npm's stderr in hand, and the
 * streaming form leaves it on the terminal where no caller can read it. So the
 * output is captured behind a spinner and the two places it matters print it.
 *
 * A FAILURE replays npm's own output verbatim, because npm has already printed
 * why in more detail than this command could summarize — and because the
 * install IS this command, so unlike the scaffold's optional install, a failure
 * here is fatal.
 *
 * A RETRY is said out loud even when it succeeded. `--legacy-peer-deps`
 * installs a tree npm deliberately declined, and here that tree is one the user
 * has been running — not `init`'s fresh one — so the module that could not be
 * satisfied is a fact about their project, not an artifact of a scaffold.
 */
async function install(pkg: string, dir: string, verb: "install" | "reinstall", rerun: string): Promise<PeerRetryResult> {
  const spin = spinner(`Installing ${style.bold(pkg)}`);
  let result: AddOutcome;
  try {
    result = await addDependency(dir, pkg, {
      rerun,
      onLink: (member) => spin.update(`Linking ${member} into the npm workspace`),
      onRetry: () => spin.update(`Installing ${pkg} (retrying with --legacy-peer-deps)`),
    });
  } finally {
    // An escaping error must not leave a live interval and a half-drawn frame.
    spin.stop();
  }

  if (result.status !== 0) {
    if (result.peerConflict !== null) {
      warn(
        result.retried
          ? `${pkg} declares a peer range this project does not satisfy; --legacy-peer-deps did not resolve it either.`
          : `${pkg} declares a peer range this project does not satisfy, and the install ran out of time before --legacy-peer-deps could be tried.`,
        "module.peer-unresolved",
      );
      process.stderr.write(terminalText(result.peerConflict.trimEnd()) + "\n");
    }
    // Verbatim, not condensed: this is the last thing printed before the throw,
    // and a summary of an npm failure is a summary of a message npm wrote to be
    // read whole.
    process.stderr.write(terminalText(result.output.trimEnd()) + "\n");
    throw new Error(`${addCommandFor(dir, pkg)} failed (exit ${result.status}).`);
  }
  // An exit 0 the project does not show is no install: said with the manager's
  // own output, which carries why. `reinstall` reports a dependency that is
  // recorded but not on disk itself, with the remedy for the tree.
  if (result.recorded === undefined || (result.landed === undefined && verb === "install")) {
    process.stderr.write(terminalText(result.output.trimEnd()) + "\n");
    throw new Error(
      `${addCommandFor(dir, pkg)} exited 0, but ` +
        (result.recorded === undefined ? `this project's package.json does not list ${pkg}` : `${result.recorded} does not resolve from this project`) +
        ` — nothing was installed.`,
    );
  }

  if (result.peerConflict !== null) {
    // Reported here rather than where it happened: a warning written while the
    // spinner was live would have been erased by the next frame.
    const refused = condenseNpmError(result.peerConflict);
    warn(
      `${pkg} declares a peer range this project does not satisfy — installed with --legacy-peer-deps.`,
      "module.legacy-peer-deps",
      ["npm refused the tree it would otherwise have installed:", ...(refused !== "" ? [refused] : [])],
    );
  }
  return result;
}

/**
 * What the reconcile did, for a reader.
 *
 * Only the outcomes that are NEWS. A module that was already correct is the
 * normal case on a second install of the same package and saying so every time
 * would bury the two lines that matter: what this run configured, and what it
 * could not.
 */
function reportSync(sync: SyncResult, json: boolean | undefined): void {
  const configured = sync.modules.filter((m) => m.action === "configured");
  // Said ONCE and up front rather than question by question. A run that could
  // not ask still wrote settings, and a reader who never saw a prompt has no
  // other way to learn that what landed in `package.json` is the module's
  // declared default rather than anyone's choice.
  if (configured.length > 0 && !canPrompt({ json })) {
    detail(
      json === true
        ? `--json: nothing was prompted, so each setting is this project's stored value or the module's declared default.`
        : `Not a terminal, so nothing was prompted — each setting is this project's stored value or the module's declared default.`,
    );
  }
  for (const mod of sync.modules) {
    if (mod.action === "configured") detail(`Configured ${mod.pkg}.`);
    if (mod.action === "removed") detail(`Dropped the settings for ${mod.pkg}, which is no longer a dependency.`);
  }
  for (const pkg of sync.unconfigured) {
    warn(`${pkg} was left unconfigured, so it runs on its own defaults.`, "module.unconfigured");
  }
}

/**
 * The one line that says what to do next — which depends entirely on WHICH KIND
 * of thing was just installed, and that is only knowable after npm has run.
 *
 * Three outcomes, each with its own sentence. A WORKSPACE module is registered
 * into `xano/index.ts`, so "import it" is right for it. A TOOLCHAIN module
 * registers nothing at all — it extends the CLI — and telling its user to go
 * import it sends them looking for an export that does not exist. A package
 * with no `"xanosdk"` field is wired the way `init` wires it — by its single
 * `register*` export — and with no such export there is nothing to say.
 *
 * The classification and the registration are the loaders' own (`moduleKind`,
 * `readRegistration`), not second ones invented here, so `install` and `init`
 * can never disagree about what a package is or how it is wired.
 */
async function reportNextStep(dir: string, spec: string): Promise<void> {
  // `absent`: npm said it succeeded, so say nothing rather than guess — a
  // `file:` or tarball specifier lands here by design. `ordinary` with no
  // `"xanosdk"` field: wired by its one `register*` export when it has one,
  // exactly as `init` wires it; with no such export, nothing to say. An
  // unrecognized `kind` has already been reported by the classifier.
  const pkg = packageNameOf(spec);
  const kind = classifyInstalled(dir, pkg);
  if (kind === "absent") return;
  if (kind === "ordinary" && hasXanoSdkField(dir, pkg)) return;

  if (kind === "toolchain") {
    detail(
      `Extends the CLI (nothing to register). Configured in this project's package.json "xanosdk" block.`,
    );
    return;
  }
  const { inProject, partitionRegistrations, readRegistration, renderImports, renderRegisterCall } = await import(
    "./init-modules.js"
  );
  const registration = await readRegistration(dir, pkg);
  if (kind === "ordinary" && !("register" in registration)) return;
  if (!("register" in registration)) {
    // No register function to look for: an import the entry reaches is the only wiring signal.
    const specifier = specifierOf(pkg);
    const importers = (reachableSources(dir) ?? backendSources(dir)).filter((f) => specifier.test(f.code)).map((f) => f.rel);
    detail(
      importers.length > 0
        ? `Already imported in ${importers.join(", ")} — nothing else to wire.`
        : `Import it in your backend (\`xano/index.ts\`) and register it onto your workspace.`,
    );
    return;
  }
  // Wired means CALLED: an import of one of its values (auth's `userTable`,
  // for chatbot) registers nothing.
  const { registrars, unknown } = backendRegistration(dir, pkg, registration.register);
  if (registrars.length > 0) {
    detail(`Already registered in ${registrars.join(", ")} — nothing else to wire.`);
    return;
  }
  const entry = join(backendDirIn(dir), "index.ts");
  const entryRel = relForwardSlash(dir, entry);
  if (unknown.length > 0) {
    // Advising a second call would fail the export as a double registration.
    detail(
      `Could not tell whether ${pkg} is registered: ${unknown.join(", ")} reaches it in a way this check cannot follow. ` +
        `Check ${entryRel} — it is wired when \`${registration.register}(…)\` runs once on your workspace.`,
    );
    return;
  }
  const manifest = readProjectManifest(dir);
  const present = new Set(manifest === null ? [] : declaredDependencies(manifest));
  const cli = `${inProject(dir)}${installedCliAt(dir)}`;
  // Options from a package the project lacks: that package first, then the
  // call below compiles. Anything else unwritable is the module's to explain.
  const missing = [
    ...new Set(
      Object.values(registration.options)
        .filter((ref) => "package" in ref && !present.has(ref.package))
        .map((ref) => (ref as { package: string }).package),
    ),
  ];
  const { unwired } = partitionRegistrations([registration], present);
  if (unwired.length > 0 && (missing.length === 0 || unwired[0]!.options === undefined)) {
    detail(`Not registered yet — import it in your backend (\`xano/index.ts\`) and register it onto your workspace; ${spellProjectCli(unwired[0]!.reason, installedCliAt(dir)).replace(/`npx /g, `\`${inProject(dir)}npx `)}.`);
    return;
  }
  const first =
    missing.length === 0
      ? ""
      : `  First add ${missing.join(", ")}, which it takes an option from: ` +
        `${missing.map((p) => `\`${cli} marketplace install ${p}\``).join(", then ")}, wired as that prints.\n`;
  // The exact lines, against the workspace the entry names, then the refresh
  // the scaffold's strict check needs: the module's objects in the lock, and
  // its endpoints in the route manifest.
  const app = workspaceBinding(entry);
  const call = renderRegisterCall(registration.register, registration.options, app);
  const lines = [
    ...renderImports([registration]),
    registration.binding === null ? call : `const ${registration.binding} = ${call}`,
  ];
  const refresh = hasRoutesScript(dir)
    ? `${cli} export ./${entryRel} --out /dev/null && npm run xano:routes`
    : `${cli} export ./${entryRel} --out /dev/null`;
  detail(
    `Not registered yet.\n${first}  Add to ${entryRel}:\n${lines.map((line) => `    ${line}`).join("\n")}\n` +
      `  Then run \`${refresh}\` to bring xano.lock and the route manifest up to date.`,
  );
}

/** The name `xano/index.ts` binds its `workspace(...)` to — `app` in every scaffold. */
function workspaceBinding(entry: string): string {
  try {
    const code = withoutComments(readFileSync(entry, "utf8"));
    const bound = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*workspace\s*\(/.exec(code);
    if (bound !== null) return bound[1]!;
  } catch {
    // No readable entry: the scaffold's name.
  }
  return "app";
}

/** Whether the project defines the scaffold's `xano:routes` script. */
function hasRoutesScript(dir: string): boolean {
  const scripts = readProjectManifest(dir)?.["scripts"];
  return typeof scripts === "object" && scripts !== null && typeof (scripts as Record<string, unknown>)["xano:routes"] === "string";
}

// ── The read verbs ──────────────────────────────────────────────────────────

/**
 * `--prompt` belongs to `details` alone. Flags are parsed globally, so without
 * this the flag would parse cleanly on any verb and then do nothing — the reader
 * asks for a prompt, gets a listing, and has no way to tell the flag was the
 * part that was ignored.
 */
function refusePromptFlag(args: ParsedArgs, verb: string): void {
  if (!args.prompt) return;
  throw new UsageError(
    `\`xanosdk marketplace ${verb}\`: --prompt belongs to \`marketplace details <package>\`, which is the verb that has an agent prompt to print.`,
    { helpFor: { command: "marketplace", subcommand: verb } },
  );
}

/** `a · b · c`, or nothing at all when there are no tags. */
function tagLine(tags: string[]): string | undefined {
  return tags.length > 0 ? tags.join(" · ") : undefined;
}

/**
 * One module as a block: the npm package name first, because that is the string
 * you retype into `install`. The slug is deliberately absent — it names the web
 * page, and printing it beside an install line invites someone to install it.
 */
function renderRow(row: CatalogueRow): string {
  const s = stdoutStyle();
  const name = row.npm_package ?? row.slug ?? "(unnamed)";
  const title = row.title !== undefined ? `  ${s.dim(safeText(row.title))}` : "";
  const lines = [`  ${s.bold(s.cyan(safeText(name)))}${title}`];
  if (row.tagline !== undefined) lines.push(`    ${safeText(row.tagline)}`);
  const tags = tagLine(row.tags);
  if (tags !== undefined) lines.push(`    ${s.dim(safeText(tags))}`);
  if (row.docs_url !== undefined) lines.push(`    ${s.dim(safeText(row.docs_url))}`);
  return lines.join("\n");
}

/**
 * The shared listing renderer. `list` and `search` differ only in what they say
 * when there is nothing to show, so that is all either passes in.
 */
function writeRows(
  args: ParsedArgs,
  rows: CatalogueRow[],
  empty: string,
  extra: Record<string, unknown> = {},
): void {
  // An object, like every other command's document, so a field can be added
  // later without breaking a reader that indexes into it.
  if (isMachineOutput(args)) {
    writeJson({ ...extra, modules: rows });
    return;
  }
  const s = stdoutStyle();
  if (rows.length === 0) {
    printHuman(`${empty}\n`);
    return;
  }
  const count = `${rows.length} add-on${rows.length === 1 ? "" : "s"}`;
  printHuman(
    `\n${s.dim(count)}\n\n` +
      rows.map(renderRow).join("\n\n") +
      `\n\n${s.dim("xanosdk marketplace details <package>  for what a module installs")}\n`,
  );
}

/** `xanosdk marketplace list` — the whole catalogue, newest first. */
export async function runMarketplaceListCommand(args: ParsedArgs): Promise<void> {
  refusePromptFlag(args, "list");
  writeRows(args, await fetchCatalogue(), "No add-ons are published yet.");
}

/** `xanosdk marketplace search <query>` — keyword match across the catalogue. */
export async function runMarketplaceSearchCommand(args: ParsedArgs): Promise<void> {
  refusePromptFlag(args, "search");
  const query = args.positionals[0];
  if (query === undefined || query === "") {
    throw missingArgument("string", { command: "marketplace", subcommand: "search" });
  }
  // Extra terms are joined rather than refused: `search ai agent` is a search for
  // two words, matched as one phrase. Nothing is dropped.
  const q = args.positionals.join(" ");
  writeRows(
    args,
    await searchCatalogue(q),
    `Nothing matched "${q}". Run \`xanosdk marketplace list\` to see everything.`,
    { query: q },
  );
}

/** The full record, as a terminal reads it. Everything you would act on, minus the prompt wall. */
function renderModule(mod: CatalogueModule): string {
  const s = stdoutStyle();
  const out: string[] = [];

  const name = mod.npm_package ?? mod.slug ?? "(unnamed)";
  out.push(`\n  ${s.bold(s.cyan(safeText(mod.title ?? name)))}`);
  if (mod.tagline !== undefined) out.push(`  ${safeText(mod.tagline)}`);
  // The long form, indented under the tagline. Without it the terminal view
  // showed strictly less than the piped JSON, which makes the pipe the better
  // way to read a page written for a human.
  if (mod.description !== undefined) {
    out.push("");
    out.push(s.dim(indentBlock(mod.description, "  ")));
  }
  out.push("");

  const fields: Array<[string, string]> = [["Package", s.bold(name)]];
  const tags = tagLine(mod.tags);
  if (tags !== undefined) fields.push(["Tags", s.dim(tags)]);
  if (mod.docs_url !== undefined) fields.push(["Docs", mod.docs_url]);
  if (mod.repo_url !== undefined) fields.push(["Repo", mod.repo_url]);
  out.push(formatFields(fields).trimEnd());

  if (mod.includes.length > 0) {
    out.push(`\n  ${s.bold("Installs")}`);
    // Widest kind sets the column, so the names line up however varied the kinds.
    const width = Math.max(...mod.includes.map((i) => (i.kind ?? "").length));
    for (const item of mod.includes) {
      const kind = s.dim((item.kind ?? "").padEnd(width));
      const summary = item.summary !== undefined ? s.dim(` — ${item.summary}`) : "";
      out.push(`    ${kind}  ${item.name ?? ""}${summary}`);
    }
  }

  if (mod.requirements.length > 0) {
    out.push(`\n  ${s.bold("You supply")}`);
    for (const req of mod.requirements) out.push(`    • ${req}`);
  }

  if (mod.register_snippet !== undefined) {
    out.push(`\n  ${s.bold("Register it")}`);
    out.push(s.dim(indentBlock(mod.register_snippet, "    ")));
  }

  // The payoff line, and the reason `slug` never appears above: this is the
  // string that works, copied straight.
  if (mod.npm_package !== undefined) {
    out.push(`\n  ${s.bold(s.green(`xanosdk marketplace install ${mod.npm_package}`))}`);
  }
  // The prompt is the one field a terminal does not want inline — it is pages of
  // instructions written for a machine. Say it exists and how to get it.
  if (mod.agent_prompt !== undefined) {
    out.push(
      `  ${s.dim(`xanosdk marketplace details ${name} --prompt  to hand the wiring to a coding agent`)}`,
    );
  }
  return out.join("\n") + "\n";
}

/** `xanosdk marketplace details <package>` — one module, by npm name or slug. */
export async function runMarketplaceDetailsCommand(args: ParsedArgs): Promise<void> {
  const pkg = resolvePackage(args, "details");

  let mod: CatalogueModule;
  try {
    mod = await fetchModule(pkg);
  } catch (err) {
    if (err instanceof ModuleNotFoundError) {
      // The catalogue's own sentence, plus the way out. A miss is usually a
      // half-remembered name, and search is what turns that into the real one.
      // Exit 8, the CLI's not-found code (`release show <missing>` uses it
      // too), so a script tells "no such module" from a catalogue failure.
      // Phrased as `install` and `remove` phrase the same miss, so one name
      // missing reads the same whichever verb met it.
      throw await notInMarketplaceError("xanosdk marketplace details", pkg);
    }
    throw err;
  }

  // A withdrawn (`listed: false`) module keeps its name reserved but is not
  // something to install. Warned before every output mode, `--prompt` included:
  // the agent path is the one most likely to act on the answer without a human
  // reading it. stderr, so a piped prompt is unaffected.
  if (mod.listed === false) {
    warn(`${mod.npm_package ?? pkg} has been removed from the marketplace.`, "module.removed-from-marketplace");
  }

  if (args.prompt) {
    // Raw and alone, on a TTY as much as through a pipe: this output exists to be
    // piped into something else, and styling or a header would corrupt it.
    if (mod.agent_prompt === undefined) {
      throw new Error(
        `${mod.npm_package ?? pkg} publishes no agent prompt. ` +
          `Run \`xanosdk marketplace details ${pkg}\` for its registration snippet instead.`,
      );
    }
    process.stdout.write(mod.agent_prompt + "\n");
    return;
  }

  if (isMachineOutput(args)) {
    writeJson(mod);
    return;
  }
  printHuman(renderModule(mod));
}
