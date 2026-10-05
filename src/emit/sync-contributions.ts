/**
 * The reconciler: one idempotent pass that brings a project's contributed state
 * into line with its `dependencies` and its stored `"xanosdk"` block.
 *
 * ── Why a reconcile rather than an installer that patches ───────────────────
 *
 * Every contribution is deterministic — composed from a module's
 * `contributes()` and the answers the project stored — and keyed by package
 * name. So the correct on-disk state is a PURE FUNCTION of `dependencies` plus
 * that block, and can be rebuilt from scratch at any moment. Three consequences
 * fall out, and each one deletes a problem an install-time patcher has:
 *
 * - **No package name to recover.** Sync reads every dependency, so a module
 *   installed from `file:../local`, a tarball or a git URL needs no name parsed
 *   out of its specifier.
 * - **No disabled-first write.** A crash part-way through leaves the prior
 *   state untouched, and re-running repairs it. Nothing has to be written in a
 *   deliberately broken order to make a half-finished run legible.
 * - **No version-stamp comparison.** "What is unanswered" is read from the
 *   config block directly, not inferred from what version last wrote it.
 *
 * It also serves every arrival path — a plain `npm install`, a merged PR, a
 * `git pull` that changed `package.json` — which an install-time patcher could
 * not see at all. That population is the reason {@link SyncResult.unconfigured}
 * exists.
 *
 * ── One traversal, three modes of asking ────────────────────────────────────
 *
 * Two independent dials, because they answer different questions. `ask` says
 * WHOM this run may put questions to: `"unanswered"` is `marketplace install`,
 * `"package"` is `marketplace reinstall`, `"none"` asks nobody. `apply` says
 * whether it may WRITE what it computes.
 *
 * They were one dial, and the seam showed: `marketplace remove` must write and
 * must ask nobody, so it passed `"package"` naming a package it had just
 * uninstalled and relied on the ask-set coming out empty — correct by
 * arithmetic rather than by saying what it meant.
 *
 * The traversal is IDENTICAL whatever the dials say, which is what keeps a
 * report and the fix from drifting: whatever any run decides is computed by the
 * code that later applies it, so no combination can describe a state the repair
 * does not produce. `apply: false` is exactly that — a dry run of the repair.
 * What `deploy`/`export` report is computed one layer down, by
 * `discoverToolchainPlugins` under `opts.configuring`, which is where the
 * unconfigured list is defined for everyone.
 *
 * ── Nothing is DECIDED until every target has been checked ──────────────────
 *
 * An unparseable `package.json`, a `"xanosdk"` key that is not an object, an
 * unbalanced managed block, a contribution the contract refuses — each aborts
 * BEFORE ANY WRITE. The complete next state of both files is computed first,
 * then both are written, so a REFUSAL never leaves one of two files patched:
 * that is the state nobody can reason about, and it is what replaces the
 * event-driven design's disabled-first write.
 *
 * A failed WRITE is a different animal, and the guarantee there is weaker on
 * purpose. `.gitattributes` is written first; if `package.json` then cannot be
 * (a read-only file, a full disk), the file on disk IS already patched. The
 * ORDER is what makes that survivable rather than restructuring it would: with
 * no config recorded, the next run does not believe a questionnaire already
 * ran — it re-asks, rewrites the same block idempotently over the one already
 * there, and then records the config. The reverse order is the unrecoverable
 * one. The refusal says both facts out loud, because a reader told only "could
 * not be written" cannot know which of the two files moved.
 *
 * ── Two targets, and the one this file will not create ──────────────────────
 *
 * `.gitattributes` at the PROJECT ROOT — git reads the file per directory and
 * applies it to that subtree, so the project-local file is the correct one for
 * a monorepo sub-package and there is no git-root walk here.
 *
 * When that file is absent it is created with the module's block ONLY. It does
 * NOT get the `* text=auto eol=lf` header: that rule applies to every path in
 * the repository, and writing one on a user's behalf from an add-on install
 * could renormalize line endings repo-wide on the next checkout. The SDK
 * refuses to let a MODULE contribute a `*` rule for exactly that reason
 * (`assertUsableContributions`); doing it here would be the same hazard with a
 * different author. That header is `init`'s alone, in `renderGitattributes`.
 *
 * And `package.json`'s `"xanosdk"` block, through `writeToolchainConfig`.
 *
 * Node-only.
 */

import { withArticle } from "../util/article.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertWritable, atomicWrite } from "../util/atomic-write.js";
import { UsageError } from "./errors.js";
import {
  blockPackages,
  composeBlock,
  findBlock,
  gitattributesSpec,
  HASH_DIALECT,
  linesOutsideBlocks,
  removeBlock,
  upsertBlock,
} from "./managed-blocks.js";
import {
  contributionOutcomes,
  recordedConfig,
  runPluginQuestionnaire,
  type ContributionOutcome,
} from "./plugin-contributions.js";
import { pluginPrompter } from "./plugin-prompt.js";
import {
  flagFor,
  hostHelpTarget,
  type AnswerSource,
  type QuestionnaireHost,
  type QuestionPrompter,
} from "./plugin-questions.js";
import {
  declaredDependencies,
  SDK_PACKAGE,
  writeToolchainConfig,
} from "./project-config.js";
import {
  discoverToolchainPlugins,
  type LoadedPlugin,
} from "./toolchain-modules.js";
import { warn } from "./ui.js";

/**
 * WHOM this run may put questions to. Says nothing about whether it writes.
 *
 * That separation is the point. While one mode meant both, `remove` — a verb
 * that must write and must ask nobody — had to pass `"package"` naming a
 * package it had just uninstalled, and rely on the ask-set coming out empty
 * because discovery could no longer find it. It worked by arithmetic rather
 * than by saying what it meant. It now says `ask: "none"`, `apply: true`.
 */
export type AskMode =
  /** Ask nobody. `marketplace remove`, and the reporting pass. */
  | "none"
  /** Ask whatever the project has not answered yet. `marketplace install`. */
  | "unanswered"
  /** Re-ask one named package, and only that one. `marketplace reinstall`. */
  | "package";

/** What {@link syncContributions} was asked to do. */
export interface SyncOptions {
  /**
   * Whether this run may WRITE what it computes.
   *
   * `false` is a dry run: the traversal is identical, so what it reports is
   * exactly what applying it would produce, and no mode can describe a state
   * the repair does not reach.
   */
  readonly apply: boolean;
  /** Whom this run may ask. */
  readonly ask: AskMode;
  /** The package to re-ask. Required when `ask` is `"package"`, ignored otherwise. */
  readonly pkg?: string;
  /**
   * Which command is asking. Names every refusal and picks its help block.
   *
   * Explicit, never derived. Derived from the ask mode it was only correct
   * while each mode had one host, and `remove` — which reconciles without
   * asking — was already the exception that told a reader who typed `remove`
   * to go re-run `reinstall`.
   */
  readonly host: QuestionnaireHost;
  /**
   * Packages to switch back ON for this run, before discovery decides what to
   * import (`marketplace reinstall`).
   *
   * Handed to discovery in memory rather than written first. The flag has to be
   * true before the import or the reconcile is a no-op that looks like it
   * worked — but WRITING it first put it outside the all-or-nothing write, so a
   * reconcile that then refused left the module enabled. This way the decision
   * and the record of it land together, and a refusal leaves the module exactly
   * as switched off as it was.
   */
  readonly enable?: readonly string[];
  /** `--json`: forces a non-interactive questionnaire. See `plugin-prompt.ts`. */
  readonly json?: boolean;
  /** The host's unrecognized flags. Whatever no question claims is refused. */
  readonly unknownFlags?: readonly string[];
  /** Overrides the TTY prompter. The seam tests drive the interactive path through. */
  readonly prompter?: QuestionPrompter;
}

/** What this run did about one module. */
export type SyncAction =
  /** Its contributions were (re)computed and the project now records them. */
  | "configured"
  /** Recomputed and already correct — nothing was rewritten. */
  | "unchanged"
  /** Its block and its config were dropped: no longer a dependency. */
  | "removed"
  /** In `dependencies`, no config block, and this run was not allowed to ask. */
  | "unconfigured"
  /** Configured but not recomputable this run, so left exactly as it was. */
  | "carried"
  /** `contributes` threw. Every byte it owns was left alone. */
  | "failed"
  /** Explicitly `enabled: false`, so never imported and never touched. */
  | "disabled";

/** One module's outcome. */
export interface SyncedModule {
  readonly pkg: string;
  readonly action: SyncAction;
  /** Where each answer came from, when a questionnaire ran for this module. */
  readonly sources?: Readonly<Record<string, AnswerSource>>;
  /**
   * The flag that answers each of those questions, keyed by the same ids.
   *
   * A question's `flag` may legitimately differ from its `id`, so this is the
   * only way a caller reading the machine output learns what to pass to answer
   * one differently next run.
   */
  readonly flags?: Readonly<Record<string, string>>;
  /** The config this run settled on, when it computed one. */
  readonly config?: Readonly<Record<string, unknown>>;
}

/** Everything one reconcile decided, and what it wrote. */
export interface SyncResult {
  readonly projectDir: string;
  /** Every declared toolchain module, in declaration order. */
  readonly modules: readonly SyncedModule[];
  /**
   * Declared toolchain modules with no config block — the enabled-with-no-
   * settings state. Reported on EVERY pass, including `apply: false`, because
   * the likeliest way a module reaches it is a plain `npm install` or a merged
   * PR, neither of which runs a xanosdk verb.
   */
  readonly unconfigured: readonly string[];
  /** Packages whose block and config were dropped for no longer being depended on. */
  readonly removed: readonly string[];
  /** Absolute paths this run actually wrote. Empty under `apply: false`. */
  readonly written: readonly string[];
  /**
   * Whether the project's state differs from what it would be after a
   * reconcile. Under `apply: false` this is what WOULD change, since such a run
   * writes nothing — which is what makes the reporting pass a dry run of the
   * repair rather than a separate opinion about it.
   */
  readonly changed: boolean;
}

/**
 * Reconcile `projectDir`.
 *
 * Idempotent: a second run changes nothing the first did not, and does not
 * rewrite an unchanged file — mtimes included. That is not a nicety. A tool
 * that rewrites two version-controlled files on every install fills a
 * repository with no-op diffs and gets added to someone's `.gitignore`.
 */
export async function syncContributions(
  projectDir: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  if (opts.ask === "package" && (opts.pkg ?? "") === "") {
    throw new Error(
      'syncContributions({ ask: "package" }) needs the package to re-ask',
    );
  }
  const manifestPath = join(projectDir, "package.json");
  const raw = readManifestText(manifestPath);
  const manifest = parseManifest(manifestPath, raw);
  const block = readWritableBlock(manifestPath, manifest);

  // ── Removal ──────────────────────────────────────────────────────────
  // A package the project still CONFIGURES but no longer DEPENDS ON. Derived
  // from `dependencies` rather than from a name the caller passed in, which is
  // why `marketplace remove` runs `npm uninstall` first and then reconciles.
  // The SAME reading of "depended on" discovery uses, imported rather than
  // re-derived: a package this pass deleted for not being a dependency must be
  // one discovery would also have declined to load.
  const depended = new Set(declaredDependencies(manifest));
  // Read HERE, ahead of the removal set, because the file is half of what
  // decides it.
  const gitattributesPath = join(projectDir, ".gitattributes");
  const before = existsSync(gitattributesPath)
    ? readFileSync(gitattributesPath, "utf8")
    : null;
  // Config keys UNION marked blocks. Derived from the config block alone this
  // leaves an ORPHAN — a marked block whose config entry is gone is owned by
  // nothing, so nothing ever drops it and its rules keep applying. Not
  // hypothetical: `marketplace remove` refuses a module recorded
  // `enabled: false` and tells the reader to delete its config entry, which
  // manufactures exactly that. A package that is neither a dependency nor
  // configured has no claim on a span of the user's file.
  //
  // The SDK's own entry is never removed: it holds the project's local
  // pin, not a module's settings, and a globally installed SDK is not a
  // dependency at all.
  const removed = [
    ...new Set([
      ...Object.keys(block),
      ...blockPackages(before ?? "", HASH_DIALECT),
    ]),
  ].filter((pkg) => pkg !== SDK_PACKAGE && !depended.has(pkg));

  const { loaded, untouchable, configured, recomputable, sources, flags, outcomes } =
    await interrogate(projectDir, opts);

  // ── The complete next state of both files, before either is written ───────
  //
  // Computed twice from the SAME pure function: once here, against the bytes
  // this run read at the top, to decide what it is going to say; and once more
  // at the moment of writing, against a fresh read. See `applyDecisions`.
  const decided: Decisions = {
    dropped: removed,
    enable: opts.enable ?? [],
    outcomes,
  };
  const base: ProjectState = { text: before, block };
  const projected = applyDecisions(base, decided);
  const after = projected.state.text;
  const actions = projected.actions;

  // The duplicate-rule warning fires HERE and not inside `applyDecisions`,
  // because that function runs twice and this is a sentence to a human. Read
  // against the base state for the same reason the whole report is: it
  // describes the file this run looked at.
  warnDuplicated(base, outcomes);

  // ── Write (only what actually differs) ────────────────────────────────────
  const applied = opts.apply
    ? applyToDisk({ manifestPath, gitattributesPath, projectDir }, decided)
    : { written: [] as readonly string[], changed: differs(base, projected.state) };
  const { written, changed } = applied;

  // ── The report ────────────────────────────────────────────────────────────
  const modules = describeRun({
    loaded,
    actions,
    dropped: removed,
    block,
    projected: projected.state,
    before,
    after,
    configured,
    recomputable,
    untouchable,
    sources,
    flags,
  });

  return {
    projectDir,
    modules,
    // DERIVED from `modules`, not accumulated alongside it. Both were built in
    // the same loop that built `modules` and were exact projections of it, with
    // nothing enforcing the agreement — so a later edit to one arm of the
    // classification could leave a package reported `unconfigured` in the list
    // and something else in the table. Computed from the table, they cannot.
    unconfigured: packagesWhere(modules, "unconfigured"),
    removed: packagesWhere(modules, "removed"),
    written,
    changed,
  };
}

/**
 * Everything this run learns by IMPORTING the project's modules and asking
 * them their questions — one phase, ending in what each module contributed.
 *
 * Separated from the reconcile because it is the half that touches the world:
 * it imports code, it may block on a human, and it refuses. What follows it is
 * pure (see {@link applyDecisions}).
 */
async function interrogate(
  projectDir: string,
  opts: SyncOptions,
): Promise<{
  readonly loaded: readonly LoadedPlugin[];
  readonly untouchable: ReadonlySet<string>;
  readonly configured: ReadonlySet<string>;
  readonly recomputable: ReadonlySet<string>;
  readonly sources: Readonly<Record<string, Readonly<Record<string, AnswerSource>>>>;
  readonly flags: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly outcomes: readonly ContributionOutcome[];
}> {
  // Discovery imports the enabled modules and skips the rest. A module
  // configured `enabled: false` is never imported at all — so it cannot be
  // asked, cannot contribute, and this run leaves every byte it owns alone.
  // `configuring: true`: this run is the fix, so discovery must not also print
  // the "installed but never configured" warning it prints for `export` and
  // `deploy`. The LIST it computes is still the one read below — one definition
  // of unconfigured, two postures about saying so.
  const { loaded, skipped, unconfigured: neverConfigured } =
    await discoverToolchainPlugins(projectDir, {
      frozen: false,
      configuring: true,
      // A module outside its SDK peer range is skipped, not refused: a skipped
      // module is untouchable below, so its settings and blocks are left exactly
      // as they are, and discovery names it with the remedy. A refusal here came
      // AFTER npm had run, leaving `remove` half done and `install` unconfigured.
      // The module a verb installs or reinstalls is refused by that verb's own
      // check before this runs.
      peerSkew: "skip",
      // `enable` is applied HERE and nowhere else — folding the pending flag
      // into what discovery reads is what lets the re-enabling land inside the
      // reconciler's single write. See `SyncOptions.enable`.
      ...(opts.enable === undefined || opts.enable.length === 0
        ? {}
        : {
            configOverride: Object.fromEntries(
              opts.enable.map((pkg) => [pkg, { enabled: true }]),
            ),
          }),
    });
  const untouchable = new Set([
    ...skipped.map((s) => s.pkg),
    ...loaded.map((p) => p.pkg),
  ]);

  // Discovery's answer, not a second reading of the same manifest: a LOADED
  // module is configured exactly when it is not in that list. (The block itself
  // still answers for packages discovery never returned — a disabled one, or
  // one that is no longer a dependency; those are not modules whose settings
  // this run could compute either way.)
  const neverConfiguredSet = new Set(neverConfigured);
  const configured = new Set(
    loaded.map((p) => p.pkg).filter((pkg) => !neverConfiguredSet.has(pkg)),
  );
  const askSet = whoToAsk(opts, loaded, configured);
  // A module is this run's business when the project already configured it or
  // when this run is allowed to ask it. Anything else is only ever reported.
  const actionable = loaded.filter(
    (p) => configured.has(p.pkg) || askSet.has(p.pkg),
  );

  // ── The questionnaire ─────────────────────────────────────────────────────
  // The shared step, in the one order every host runs it. The only thing this
  // host adds is the GATE: a prompter that asks only about the packages this
  // run is re-asking, so every module still resolves answers and one that is
  // not being asked falls through to its stored answer and then to its declared
  // default — the same two ranks a non-interactive run uses.
  const { answers, sources, flags, prior } = await runPluginQuestionnaire(actionable, {
    host: opts.host,
    unknownFlags: opts.unknownFlags ?? [],
    prompter: gate(
      askSet,
      opts.prompter ?? pluginPrompter({ json: opts.json }),
    ),
  });

  // Which modules this run may RECOMPUTE, as opposed to carry forward.
  //
  // Recomputing needs faithful answers. A module that was asked has them; one
  // with no questions has nothing to be unfaithful about; one whose
  // `answersFromConfig` read its block back has them by the contract's own
  // promise. A configured module with questions and NO inverse has none — its
  // shipped defaults are not what the project chose — so re-deriving its
  // contributions would silently reset a directory the user picked. It is left
  // exactly as it is, and reported as carried.
  const recomputable = new Set(
    actionable
      .filter(
        (p) =>
          askSet.has(p.pkg) ||
          (p.plugin.questions?.length ?? 0) === 0 ||
          prior[p.pkg],
      )
      .map((p) => p.pkg),
  );
  assertNoFlagsForCarried(actionable, recomputable, sources, opts.host);
  const outcomes = contributionOutcomes(
    actionable.filter((p) => recomputable.has(p.pkg)),
    answers,
    opts.host,
  );

  return { loaded, untouchable, configured, recomputable, sources, flags, outcomes };
}

/**
 * Re-decide against the bytes on disk NOW, and write what differs.
 *
 * ── Why it reads again ──────────────────────────────────────────────────────
 *
 * The questionnaire blocks on a human, so the window between the read at the
 * top of {@link syncContributions} and this point is unbounded — long enough
 * for another `marketplace` verb, an `npm install` or a hand edit to land in
 * it. Writing back the state composed against the stale read would revert
 * whatever arrived, and for the config block that is not an ordinary lost
 * update: a deleted `enabled: false` is an `enabled: false` REVERSED, because
 * absent config reads as enabled.
 *
 * Replaying this run's DECISIONS over the fresh bytes is what makes the two
 * runs compose. Every decision is keyed by package, so the replay touches only
 * the packages this run actually settled and leaves every other byte as the
 * other writer left it. The fresh read goes back through the same refusals: a
 * manifest that became unparseable, or a `"xanosdk"` key that became a string,
 * is refused rather than written over — the check at the top of the function is
 * not evidence about a file that has since been rewritten.
 *
 * ── Order ───────────────────────────────────────────────────────────────────
 *
 * `.gitattributes` first. If that throws, the config was never written, so the
 * next run recomputes both from unchanged inputs rather than skipping a
 * questionnaire it believes already ran. The reverse order is the
 * unrecoverable one; see the module header.
 */
function applyToDisk(
  paths: {
    readonly manifestPath: string;
    readonly gitattributesPath: string;
    readonly projectDir: string;
  },
  decisions: Decisions,
): { readonly written: readonly string[]; readonly changed: boolean } {
  const freshManifest = parseManifest(
    paths.manifestPath,
    readManifestText(paths.manifestPath),
  );
  const fresh: ProjectState = {
    text: existsSync(paths.gitattributesPath)
      ? readFileSync(paths.gitattributesPath, "utf8")
      : null,
    block: readWritableBlock(paths.manifestPath, freshManifest),
  };

  // The removal set is the ONE decision whose premise can expire.
  //
  // Every other decision is about a module this run interrogated, so replaying
  // it over fresh bytes is faithful to what the module said. "No longer a
  // dependency" is instead a claim about the `dependencies` map — and that map
  // has just been re-read. A package another run installed and configured in
  // the window is depended on again, so dropping it would delete that run's
  // work: the same lost update the re-read exists to prevent, pointed the other
  // way. Re-checked rather than recomputed, so this run still only ever drops
  // packages it had already resolved to drop.
  const depended = new Set(declaredDependencies(freshManifest));
  const stillGone = decisions.dropped.filter((pkg) => !depended.has(pkg));
  const final = applyDecisions(fresh, { ...decisions, dropped: stillGone }).state;
  const written: string[] = [];

  // Both targets, before either is written. `.gitattributes` goes first, so a
  // manifest that cannot be written would otherwise leave one of two files
  // patched — the state the header's all-or-nothing rule exists to rule out.
  // Checking permission on both up front puts the ordinary read-only case back
  // under that rule; a write that fails for another reason still falls to the
  // partial-write message below.
  refuseUnwritable(paths.manifestPath);
  refuseUnwritable(paths.gitattributesPath);

  if (textChanged(fresh.text, final.text) && final.text !== null) {
    if (final.text === "" && fresh.text !== null && fresh.text !== "") {
      // Only managed blocks were in it and this run dropped the last of them,
      // so the file is one an install created and nothing else claims. A file
      // that was ALREADY empty never reaches here: nothing proves who made it.
      rmSync(paths.gitattributesPath, { force: true });
    } else {
      write(paths.gitattributesPath, final.text);
    }
    written.push(paths.gitattributesPath);
  }
  if (!sameBlock(fresh.block, final.block)) {
    try {
      if (writeToolchainConfig(paths.projectDir, final.block))
        written.push(paths.manifestPath);
    } catch (error) {
      // `.gitattributes` may already be on disk by now — see the header. Say
      // so, and say that re-running finishes the job, because the alternative
      // is a reader who assumes a half-written project and starts undoing a
      // block the next run would have rewritten identically anyway.
      throw writeFailure(paths.manifestPath, error, written.length > 0);
    }
  }

  return { written, changed: differs(fresh, final) };
}

/** Every package the run put in one action — the projections `SyncResult` exposes. */
function packagesWhere(
  modules: readonly SyncedModule[],
  action: SyncAction,
): readonly string[] {
  return modules.filter((m) => m.action === action).map((m) => m.pkg);
}

/**
 * What the run did, module by module — the whole of {@link SyncResult.modules}.
 *
 * Three populations, and they do not overlap: what discovery LOADED, what this
 * run DROPPED, and what the project configures that discovery never returned.
 */
function describeRun(ctx: {
  readonly loaded: readonly LoadedPlugin[];
  readonly actions: ReadonlyMap<string, SyncAction>;
  readonly dropped: readonly string[];
  readonly block: Readonly<Record<string, unknown>>;
  readonly projected: ProjectState;
  readonly before: string | null;
  readonly after: string | null;
  readonly configured: ReadonlySet<string>;
  readonly recomputable: ReadonlySet<string>;
  readonly untouchable: ReadonlySet<string>;
  readonly sources: Readonly<Record<string, Readonly<Record<string, AnswerSource>>>>;
  readonly flags: Readonly<Record<string, Readonly<Record<string, string>>>>;
}): readonly SyncedModule[] {
  const nextBlock = ctx.projected.block;
  const modules: SyncedModule[] = [];

  for (const p of ctx.loaded) {
    const action =
      ctx.actions.get(p.pkg) ??
      classify(p, {
        configured: ctx.configured,
        nextBlock,
        recomputable: ctx.recomputable,
      });
    modules.push({
      pkg: p.pkg,
      action:
        action === "configured" &&
        !changedFor(p.pkg, ctx.block, nextBlock, ctx.before, ctx.after)
          ? "unchanged"
          : action,
      ...(ctx.sources[p.pkg] === undefined ? {} : { sources: ctx.sources[p.pkg] }),
      ...(ctx.flags[p.pkg] === undefined ? {} : { flags: ctx.flags[p.pkg] }),
      ...(nextBlock[p.pkg] === undefined
        ? {}
        : { config: nextBlock[p.pkg] as Readonly<Record<string, unknown>> }),
    });
  }

  for (const pkg of ctx.dropped) modules.push({ pkg, action: "removed" });

  // A configured module that discovery never returned and never reported as
  // broken was skipped for being `enabled: false` — the one state that is
  // decided from JSON, before anything is imported. Only an entry that SAYS
  // so is reported: the SDK's own key holds the Xano Engine pin, not a
  // module, and reporting it "disabled" named a module that does not exist.
  for (const [pkg, config] of Object.entries(ctx.block)) {
    if (pkg === SDK_PACKAGE || ctx.untouchable.has(pkg) || ctx.dropped.includes(pkg)) continue;
    if ((config as { enabled?: unknown } | null)?.enabled === false)
      modules.push({ pkg, action: "disabled" });
  }

  return modules;
}

/**
 * The two files this reconcile owns, as VALUES rather than as bytes on disk.
 *
 * `text` is `.gitattributes`, null when the file does not exist; `block` is the
 * manifest's `"xanosdk"` key. Paired because every decision below is a decision
 * about both at once.
 */
interface ProjectState {
  readonly text: string | null;
  readonly block: Readonly<Record<string, unknown>>;
}

/**
 * What one reconcile DECIDED, separate from the bytes it decided against.
 *
 * This is the whole point of the split. A decision is keyed by package and is
 * a pure function of the module's outcome, so it can be replayed over any base
 * state — including one another process wrote while this run's questionnaire
 * was open. Nothing in here is a diff against a particular file.
 */
interface Decisions {
  /** Packages whose block and config are dropped: no longer a dependency. */
  readonly dropped: readonly string[];
  /**
   * Packages this run switches back on (`SyncOptions.enable`).
   *
   * Here as well as in discovery, because the two do different halves of the
   * job. Discovery takes the flag IN MEMORY, which is what gets the module
   * imported and asked; this is what RECORDS it. Nothing else would: a module
   * whose `contributes` returns no `config` of its own leaves `recordedConfig`
   * answering `undefined`, so the stored `enabled: false` would survive a run
   * that announced it was re-enabling the module — and the run would still
   * write the module's rules, leaving a manifest and a `.gitattributes` that
   * disagree about whether the module is on.
   */
  readonly enable: readonly string[];
  /** What each actionable module's `contributes` produced. */
  readonly outcomes: readonly ContributionOutcome[];
}

/**
 * Apply `decisions` to `base`, yielding the state both files should have.
 *
 * PURE, and that is load-bearing rather than tidy: the reconciler runs it once
 * against the bytes it read at the top (to decide what to report) and once
 * against a fresh read at the moment of writing (to decide what to write). A
 * report and the write that follows it cannot describe different states when a
 * single function computes both.
 *
 * It follows that the state is rebuilt rather than patched. Only packages named
 * in `decisions` are touched; every other key of the block and every other span
 * of the file survives exactly as `base` had it.
 */
function applyDecisions(
  base: ProjectState,
  decisions: Decisions,
): { readonly state: ProjectState; readonly actions: ReadonlyMap<string, SyncAction> } {
  let text = base.text;
  const block: Record<string, unknown> = { ...base.block };

  for (const pkg of decisions.dropped) {
    delete block[pkg];
    text = removeBlock(text, gitattributesSpec(pkg)).text;
  }

  // BEFORE the outcomes loop, so the flag is part of the state each outcome is
  // recorded against rather than something written over it. That ordering is
  // what keeps the documented escape hatch: a module whose own answer switches
  // it off contributes nothing, and `recordedConfig` then returns
  // `{ enabled: false }`, which lands after this and wins.
  for (const pkg of decisions.enable) {
    const stored = block[pkg];
    block[pkg] = {
      ...(typeof stored === "object" && stored !== null && !Array.isArray(stored)
        ? stored
        : {}),
      enabled: true,
    };
  }

  const actions = new Map<string, SyncAction>();
  for (const outcome of decisions.outcomes) {
    if (outcome.status === "failed") {
      // `contributes` threw. We know nothing about what this module wants, so
      // nothing it owns is touched — not its block, and above all not its
      // config, whose presence is what tells the next run the questionnaire
      // already completed.
      actions.set(outcome.pkg, "failed");
      continue;
    }
    if (outcome.status === "contributed") {
      // Removing the BLOCK and removing the CONFIG are different deletions. An
      // empty contribution means the module was switched off, and dropping its
      // `.gitattributes` block is correct — a stale rule would keep applying
      // something the user just turned off. What to do about its CONFIG is the
      // shared rule in `recordedConfig`, below, and is NOT the same answer.
      const spec = gitattributesSpec(outcome.pkg);
      const lines = outcome.parts?.gitattributes ?? [];
      text = upsertBlock(text, spec, composeBlock(spec, lines, outcome.version)).text;
    }

    // The one rule `init` and this loop both decide by — see `recordedConfig`.
    // The only config deletion this file owns is the removal pass above, where
    // the package is no longer a dependency at all. Read against THIS base, so
    // a replay over fresh bytes sees what the project actually stores now.
    const record = recordedConfig(outcome, block[outcome.pkg]);
    if (record !== undefined) block[outcome.pkg] = record;
  }

  return { state: { text, block }, actions };
}

/**
 * Refuse a target this run is not allowed to overwrite, naming the path.
 *
 * `assertWritable` throws the raw `EACCES`, which names neither the file in
 * terms the reader can act on nor what to do about it. Every other refusal in
 * this file is a `UsageError`; this one has to be too.
 */
function refuseUnwritable(path: string): void {
  try {
    assertWritable(path);
  } catch (error) {
    throw writeFailure(path, error);
  }
}

/** Whether `.gitattributes` would be rewritten. An absent file counts as empty. */
function textChanged(before: string | null, after: string | null): boolean {
  if (before === null) return (after ?? "").trim() !== "";
  return after !== null && after !== before;
}

/** Whether the `"xanosdk"` key would be rewritten. */
function sameBlock(
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether either file would be rewritten. */
function differs(before: ProjectState, after: ProjectState): boolean {
  return (
    textChanged(before.text, after.text) || !sameBlock(before.block, after.block)
  );
}

/**
 * The duplicate-rule warning, over every module that contributed.
 *
 * Read against the base state and computed ONCE: the unmarked-line scan is
 * loop-invariant in the way that matters, since the loop only ever writes
 * MARKED blocks and a marked block contributes no unmarked line.
 */
function warnDuplicated(base: ProjectState, outcomes: readonly ContributionOutcome[]): void {
  if (base.text === null) return;
  const unmarked = new Set(linesOutsideBlocks(base.text, HASH_DIALECT));
  for (const outcome of outcomes) {
    if (outcome.status !== "contributed") continue;
    warnIfDuplicated(base.text, outcome.pkg, outcome.parts?.gitattributes ?? [], unmarked);
  }
}

/** Which packages this run may put questions to a human about. */
function whoToAsk(
  opts: SyncOptions,
  loaded: readonly LoadedPlugin[],
  configured: ReadonlySet<string>,
): ReadonlySet<string> {
  if (opts.ask === "none") return new Set();
  if (opts.ask === "package") {
    return new Set(loaded.filter((p) => p.pkg === opts.pkg).map((p) => p.pkg));
  }
  return new Set(
    loaded.filter((p) => !configured.has(p.pkg)).map((p) => p.pkg),
  );
}

/**
 * A prompter that only asks about the packages this run is re-asking.
 *
 * Gating here rather than by running the questionnaire twice is what keeps the
 * traversal single: every module still resolves answers, and a module that is
 * not being asked simply falls through to its stored answer and then to its
 * declared default — the same two ranks a non-interactive run uses.
 */
function gate(
  askSet: ReadonlySet<string>,
  inner: QuestionPrompter,
): QuestionPrompter {
  return {
    ask: (pkg, question, fallback) =>
      askSet.has(pkg)
        ? inner.ask(pkg, question, fallback)
        : Promise.resolve(undefined),
  };
}

/**
 * Warn when a module's lines are already in the file but its MARKERS are not.
 *
 * Someone deleted the markers and kept the rules, or applied the module's
 * README by hand before installing it. Appending a block regardless is correct
 * — the SDK owns the span it marks and cannot adopt an unmarked line — but
 * doing it without a word leaves a duplicated rule the reader has to find.
 */
function warnIfDuplicated(
  text: string | null,
  pkg: string,
  lines: readonly string[],
  outside: ReadonlySet<string>,
): void {
  if (text === null || lines.length === 0) return;
  if (findBlock(text, gitattributesSpec(pkg)) !== null) return;
  const already = lines
    .map((l) => l.trim())
    .filter((l) => l !== "" && outside.has(l));
  if (already.length === 0) return;
  warn(
    `.gitattributes already carries ${already.length === 1 ? "a rule" : "rules"} ${pkg} contributes, outside any managed block.`,
    "module.gitattributes-conflict",
    [
      ...already,
      `A block for ${pkg} was added anyway — the SDK can only rewrite the span it marks. ` +
        `Delete the unmarked ${already.length === 1 ? "copy" : "copies"} by hand.`,
    ],
  );
}

/** What happened to a loaded module this run, when no outcome named it. */
function classify(
  p: LoadedPlugin,
  ctx: {
    configured: ReadonlySet<string>;
    nextBlock: Record<string, unknown>;
    recomputable: ReadonlySet<string>;
  },
): SyncAction {
  if (ctx.recomputable.has(p.pkg)) return "configured";
  if (ctx.configured.has(p.pkg)) return "carried";
  return "unconfigured";
}

/** Whether anything this package owns differs between before and after. */
function changedFor(
  pkg: string,
  block: Readonly<Record<string, unknown>>,
  nextBlock: Record<string, unknown>,
  before: string | null,
  after: string | null,
): boolean {
  if (JSON.stringify(block[pkg]) !== JSON.stringify(nextBlock[pkg]))
    return true;
  return blockText(before, pkg) !== blockText(after, pkg);
}

function blockText(text: string | null, pkg: string): string | null {
  if (text === null) return null;
  try {
    return findBlock(text, gitattributesSpec(pkg))?.text ?? null;
  } catch {
    return null;
  }
}

// ── Reading the manifest as a WRITER ─────────────────────────────────────────
//
// `project-config.ts` answers null for everything unreadable, which is right
// for a reader: a caller that only wants to know what a module was configured
// with can fall back to defaults. A writer cannot. Answering `{}` for a
// `"xanosdk"` key that is a string would publish a block over the top of it and
// destroy whatever the user meant by it, so each of these is refused BY NAME
// and before anything is written.

function readManifestText(path: string): string {
  if (!existsSync(path)) {
    throw new UsageError(
      `${path} does not exist, so there is no project here to reconcile.`,
      {
        suggestion:
          "Run this from a project directory, or scaffold one with `xanosdk init`.",
      },
    );
  }
  return readFileSync(path, "utf8");
}

function parseManifest(path: string, raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new UsageError(
      `${path} is not valid JSON, so this project's toolchain modules cannot be reconciled: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { suggestion: "Repair the file and re-run. Nothing was written." },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(
      `${path} is not a JSON object, so it is not a usable package manifest.`,
      {
        suggestion: "Repair the file and re-run. Nothing was written.",
      },
    );
  }
  return parsed as Record<string, unknown>;
}

function readWritableBlock(
  path: string,
  manifest: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const block = manifest["xanosdk"];
  if (block === undefined) return {};
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new UsageError(
      `the "xanosdk" key in ${path} is ${describe(block)} where a map from package name to that ` +
        `module's settings is expected, so this run would have written over it.`,
      {
        suggestion: "Repair or delete the key and re-run. Nothing was written.",
      },
    );
  }
  for (const [pkg, own] of Object.entries(block as Record<string, unknown>)) {
    if (typeof own !== "object" || own === null || Array.isArray(own)) {
      throw new UsageError(
        `the "xanosdk" entry for ${pkg} in ${path} is ${describe(own)} where that module's ` +
          `settings object is expected, so this run would have written over it.`,
        {
          suggestion:
            "Repair or delete the entry and re-run. Nothing was written.",
        },
      );
    }
  }
  return block as Record<string, unknown>;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return withArticle(typeof value);
}

function write(path: string, text: string): void {
  try {
    // Staged and renamed, never truncated in place. Both targets are
    // version-controlled files this file REFUSES to read back when they are
    // malformed, so a `kill -9` part-way through an in-place write would not
    // leave a stale project — it would leave one no later run repairs without
    // a hand edit. The shared helper also removes its staging file on the way
    // out, so a failed write leaves the directory as it found it.
    //
    // The permission check is explicit because rename asks the DIRECTORY, not
    // the file: without it a `.gitattributes` the owner locked would be
    // replaced silently. See `assertWritable`.
    assertWritable(path);
    atomicWrite(path, text);
  } catch (error) {
    throw writeFailure(path, error);
  }
}

/**
 * A write that failed names the PATH — the one fact the reader needs to act.
 *
 * `partial` says the OTHER file was already written. It changes the REMEDY, not
 * the cause: re-running is still a complete repair, because no config was
 * recorded and so the next run re-asks and rewrites the same block over itself.
 * Only a reader who is told that will re-run instead of hand-reverting.
 */
function writeFailure(
  path: string,
  error: unknown,
  partial = false,
): UsageError {
  return new UsageError(
    `${path} could not be written: ${error instanceof Error ? error.message : String(error)}`,
    {
      suggestion: partial
        ? `Check the file's permissions and re-run. \`.gitattributes\` was already written, but ` +
          `nothing was recorded in package.json — so re-running re-asks and completes the job, ` +
          `and the block it writes is the one already there.`
        : "Check the file's permissions and re-run.",
    },
  );
}

/**
 * Refuse a plugin flag aimed at a module this run will not RECOMPUTE.
 *
 * Every module resolves answers (that is what the gate buys), but a CARRIED
 * module's answers are then thrown away: its contributions are left exactly as
 * they are. A flag that answered one of its questions therefore did nothing —
 * while `sources` reported `"flag"`, which is a lie in the machine output that
 * exists to be trustworthy.
 *
 * Refused rather than made recomputable: the flag is a faithful answer to ONE
 * question, and re-deriving the module from it would reset every OTHER setting
 * to a shipped default — the silent reset `carried` exists to prevent.
 */
function assertNoFlagsForCarried(
  actionable: readonly LoadedPlugin[],
  recomputable: ReadonlySet<string>,
  sources: Readonly<Record<string, Readonly<Record<string, AnswerSource>>>>,
  host: QuestionnaireHost,
): void {
  for (const p of actionable) {
    if (recomputable.has(p.pkg)) continue;
    const names = Object.entries(sources[p.pkg] ?? {})
      .filter(([, source]) => source === "flag")
      .flatMap(([id]) => (p.plugin.questions ?? []).filter((q) => q.id === id))
      .map((q) => `\`--${flagFor(q)}\``);
    if (names.length === 0) continue;
    throw new UsageError(
      `${names.join(", ")} answers a question for ${p.pkg}, but this run does not re-derive ` +
        `that module's contributions — it has no way to read its stored settings back, so it ` +
        `carries them forward untouched and the flag would have changed nothing.`,
      {
        helpFor: hostHelpTarget(host),
        suggestion:
          `Run \`xanosdk marketplace reinstall ${p.pkg}\` with the flag: that is the verb that ` +
          `re-asks one module and rewrites what it contributes.`,
      },
    );
  }
}
