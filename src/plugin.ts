/**
 * `@xano/sdk/plugin` — the contract a **toolchain module** compiles against.
 *
 * ── The two kinds of module ─────────────────────────────────────────────────
 *
 * A WORKSPACE module (`@xano-sdk/auth`, `@xano-sdk/chatbot`) adds tables and
 * endpoints to the deployed bundle. You install it, register it in your
 * `xano/index.ts`, and what it contributes ships to your instance.
 *
 * A TOOLCHAIN module extends the **CLI** instead. It adds nothing to the
 * workspace — registering it into `xano/index.ts` would be meaningless, because
 * there is nothing to register. What it does is participate in the commands:
 * declare questions, contribute to files the project owns, and run when a
 * bundle is compiled or a workspace is checked.
 *
 * The shape this contract was built for is a module that renders the compiled
 * workspace to a committed tree on every deploy, so a backend change can be
 * reviewed as what the engine will actually run.
 *
 * ── Contributions apply to a PROJECT, not to a scaffold ─────────────────────
 *
 * A module is configured whenever its project is RECONCILED, and `xanosdk init`
 * is only the first of those moments. Installing the module into a project that
 * already exists, re-answering its questions later, and removing it again all
 * run the same pass: read what the project declares, ask what is unanswered,
 * and bring the files it owns into line.
 *
 * So {@link ToolchainPlugin.contributes} is a pure function from answers to
 * contributions, with no knowledge of which command is running and no access to
 * the filesystem. Only that makes the reconcile idempotent — the correct state
 * is a function of the project's dependencies and its stored answers, so it can
 * be rebuilt from scratch at any moment, however the module arrived.
 *
 * ── Why this is a types-only entry ──────────────────────────────────────────
 *
 * Nothing here has a runtime representation. A module does:
 *
 *     import type { ToolchainPlugin, BundleContext } from "@xano/sdk/plugin";
 *
 * and the import erases at compile time, so the module's published bundle does
 * not carry the SDK and does not resolve it at runtime. That matters because
 * the SDK is the thing IMPORTING the plugin — a plugin that pulled the SDK back
 * in would load a second copy of the compiler into the process that is already
 * running one.
 *
 * The plugin's own `package.json` still declares `@xano/sdk` as a **peer**,
 * because the hooks are handed real compiled data and the module is only
 * correct against the SDK versions whose shapes it understands.
 *
 * ── How the SDK finds a plugin ──────────────────────────────────────────────
 *
 * From the module's own `package.json`:
 *
 *     "xanosdk": { "kind": "toolchain", "plugin": "./dist/plugin.js" }
 *
 * `kind` routes it away from the workspace loader; `plugin` names the file
 * whose default export is a {@link ToolchainPlugin}.
 *
 * Per-project configuration lives in the CONSUMING project's `package.json`,
 * under the same `"xanosdk"` key, namespaced by package name:
 *
 *     "xanosdk": { "@acme/reviewable": { "enabled": true, "dir": "rendered" } }
 *
 * That block is written from the answers to {@link ToolchainPlugin.questions}
 * and read back on every later run, which is what makes a choice made once
 * survive every run after it. It is also the only memory a module has, which is
 * why {@link ToolchainPlugin.answersFromConfig} exists: without the inverse
 * mapping, re-asking the questions would offer shipped defaults and silently
 * overwrite what the user chose.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Questions and contributions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One question a module contributes to the questionnaire.
 *
 * DECLARATIVE DATA, never a prompt callback, and the two reasons are both
 * hard. A callback would let a module hang a command on a TTY read in CI, where
 * there is no one to answer it — the SDK could not even impose a timeout,
 * because it cannot tell a slow prompt from a slow computation. And
 * `init --web` renders the questionnaire as a browser form, which can display
 * a list of choices but cannot run a module's callback at all.
 *
 * Declaring the question as data means the SDK owns every way of answering it:
 * interactively, from a derived flag, from a form field, or from the answer the
 * project already stored.
 */
export interface PluginQuestion {
  /** Stable key this question's answer is stored under. */
  readonly id: string;
  /** The prompt shown to a human. One line, no trailing punctuation. */
  readonly label: string;
  /** What kind of answer this takes. */
  readonly type: "boolean" | "string" | "choice";
  /** The allowed values, for `type: "choice"`. Ignored otherwise. */
  readonly choices?: readonly string[];
  /**
   * The answer used when the question is not asked and the project has stored
   * nothing for it — a non-interactive run with no flag, or a `when` that
   * excluded it.
   *
   * A project's own stored answer OUTRANKS this: on a re-ask, the stored value
   * is both the prompt's default and the non-interactive fallback, so a
   * repeated run never quietly resets a choice back to what you shipped.
   */
  readonly default: string | boolean;
  /**
   * The long-flag name that answers this question without a prompt, without
   * its leading dashes.
   *
   * Derived from `id` when omitted. Declare it when the derived name would read
   * badly — `--reviewable-dir` rather than `--dir` — or would collide with a
   * flag the CLI already owns. A collision is REFUSED, with a message naming
   * your module and the command that hit it, so it fails loudly rather than
   * binding your question to a flag the CLI consumed first.
   *
   * A `string` or `choice` question is answered with `--flag=value`, not
   * `--flag value`. The CLI cannot know a contributed flag takes a value — your
   * module is not loaded when the arguments are parsed — so it never consumes
   * the following token, and the spaced form would leave that value where a
   * positional argument is read from. A `boolean` question takes the bare
   * `--flag`, or `--no-flag` to decline one whose default is true.
   */
  readonly flag?: string;
  /**
   * Whether to ask at all, given the answers so far.
   *
   * A question excluded this way is not asked AND no answer is recorded for it
   * — an unasked question has no answer, and recording one would make a later
   * `deploy` act on a choice nobody made. On a re-ask that also means a stale
   * key a previous run stored for it is DELETED from the project's config, and
   * the deletion is reported.
   */
  readonly when?: (answers: PluginAnswers) => boolean;
}

/** The answers to a module's own questions, keyed by {@link PluginQuestion.id}. */
export type PluginAnswers = Readonly<Record<string, string | boolean>>;

/**
 * What a module contributes to a project — computed from its answers, applied
 * whenever the project is reconciled.
 *
 * ADDITIVE AGAINST NAMED SLOTS THE SDK OWNS — a module returns lines and a
 * config object, and the SDK composes them into the files it maintains. A
 * module never hands back a whole file, never rewrites a script string, and
 * never touches the disk itself.
 *
 * That constraint is what makes two installed modules safe together: neither
 * can clobber the other's contribution, because neither is writing the file.
 * Each module's lines land in a marked block naming it, so re-answering its
 * questions rewrites exactly that span and nothing around it — which is what
 * lets a module be re-configured or removed in a project that already exists.
 *
 * It also moves the failure earlier: a malformed contribution is refused where
 * it was written rather than producing a broken file the user meets later.
 *
 * PURE. Called with nothing but the answers, possibly several times in one run,
 * and expected to return the same contributions for the same answers.
 *
 * An EMPTY contribution is meaningful: returning no `gitattributes` lines
 * REMOVES the module's block rather than leaving an empty one, which is how a
 * module whose answers turned it off stops applying rules the user declined.
 */
export interface ProjectContributions {
  /**
   * Lines the module adds to the project's `.gitattributes`, in its own marked
   * block. Each entry is one line, without a trailing newline.
   *
   * A rule for `*`, or one that sets `text`/`eol`, is REFUSED: both apply to
   * paths the module does not own — `*` to every path in the repository — and
   * could renormalize line endings repo-wide on the next checkout. Contribute
   * display rules (`linguist-*`, `diff`) for the paths you own instead.
   */
  readonly gitattributes?: readonly string[];
  /**
   * The module's own block in the project's `package.json` `"xanosdk"` object,
   * stored under the module's package name.
   *
   * This is the value {@link BundleContext.config} hands back on every later
   * run, so it is the module's whole memory of what was decided — and the value
   * {@link ToolchainPlugin.answersFromConfig} is asked to read back.
   */
  readonly config?: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook results
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a hook reports back.
 *
 * `failed` is distinct from a thrown error, and the distinction is the whole
 * reason the field exists. A THROWN error is a broken plugin: it could not do
 * its job, and on a normal run the command carries on without it. `failed` is a
 * working plugin reporting that **the thing it checked does not pass** — a
 * committed tree that no longer matches the source, say.
 *
 * Collapsing the two would break both directions. A bug in a plugin would fail
 * a deploy that is fine, and a real staleness finding would be swallowed as a
 * plugin bug. `preflight` maps `failed` onto the same non-zero exit code it
 * uses for its own findings, which is what lets CI keep gating on it.
 */
export interface HookResult {
  /** One line for the command's normal output. Omitted when there is nothing to say. */
  readonly message?: string;
  /** Per-item notes shown under the message. */
  readonly warnings?: readonly string[];
  /**
   * The check this hook performed did not pass.
   *
   * Not "the hook errored" — see above. Set this only when the plugin ran
   * correctly and the answer is no.
   */
  readonly failed?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook contexts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A compiled workspace bundle's payload — the object every kind's encoded
 * records hang off, keyed by payload key (`table`, `query`, `app`, …).
 *
 * Structural rather than imported from the compiler on purpose: this entry has
 * to stay types-only and self-contained, and a plugin that wants the precise
 * per-kind shapes can depend on `@xano/sdk/internal` for them.
 */
export type BundlePayload = Readonly<Record<string, unknown>>;

/** Which command a hook is firing under. */
export type HookCommand = "export" | "deploy";

/**
 * What `onBundle` is handed.
 *
 * Fired on `export` and `deploy`, AFTER the bundle compiles and BEFORE the
 * network call. That placement is deliberate: the tree describes the SOURCE, so
 * writing it before the deploy means a failed deploy still leaves a correct
 * tree, and a tree never claims something shipped that did not.
 */
export interface BundleContext {
  /**
   * The compiled payload.
   *
   * Workspace env VALUES are blanked before you see them — `payload.env`
   * entries keep their `name` and carry `value: ""`. A hook's output is
   * typically committed, and the real values come from a gitignored file, so
   * handing them to a renderer would be handing them to git. The declarations
   * survive because they are structure; the secrets do not.
   */
  readonly bundle: { readonly payload: BundlePayload };
  /**
   * The entry file the bundle was compiled from — **absent** on the
   * `--bundle <path>` branch, where the input is already-serialized text with
   * no entry and no registry behind it.
   *
   * Optional rather than a made-up path because a plugin may legitimately want
   * to decline that branch: a tree rendered from a bundle the project did not
   * compile describes something other than the source beside it.
   */
  readonly entry?: string;
  /** The project root every relative path resolves against. */
  readonly cwd: string;
  /** Which command fired this. */
  readonly command: HookCommand;
  /**
   * The run is a verification, not a write: `--frozen-lock`, `export --check`,
   * or `deploy --to … --dry-run`.
   *
   * A plugin under `frozen` must COMPARE and report, never write. It is also
   * the mode in which a plugin failing to load is fatal rather than a warning
   * — a guard that silently stops running is worse than one that fails loudly.
   */
  readonly frozen: boolean;
  /** The running `@xano/sdk` version, for a plugin's own peer-range check. */
  readonly sdkVersion: string;
  /** This module's block from the project's `package.json` `"xanosdk"` object. */
  readonly config: Readonly<Record<string, unknown>>;
}

/**
 * The engine's own rendering of the deployed workspace, or why it could not be
 * had.
 *
 * Tagged because the difference is load-bearing: a missing text route must
 * report as UNAVAILABLE, never as drift. Treating a failed fetch as an empty
 * rendering would diff every object in the workspace against nothing and
 * report a catastrophic mismatch that is really a network error.
 */
export type EngineRendering =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "error"; readonly why: string };

/**
 * What `onPreflight` is handed.
 *
 * The SDK owns the FETCH and nothing else. `exportMultidoc` is a generic engine
 * route — the same class of thing as an API query parameter — and it is not
 * reachable from any published subpath, so a plugin could not call it itself.
 *
 * Every derivation past that point belongs to the plugin: it has both payloads,
 * so it renders both local sides and computes its own exclusions. No rendering
 * knowledge stays behind in the SDK.
 */
export interface PreflightContext {
  /** The engine's rendering of what it actually has, or why it is unavailable. */
  readonly engineRendering: EngineRendering;
  /**
   * The payload as the ENGINE exported it after import — so both sides of a
   * comparison built from this share one JSON, and any difference is the
   * plugin's own rendering.
   *
   * Env values are blanked here too, for the reason given on
   * {@link BundleContext.bundle}. Both payloads are blanked identically, so a
   * comparison between them is unaffected; a comparison against
   * {@link PreflightContext.engineRendering} should exclude env values, which
   * the engine has no reason to blank.
   */
  readonly exportedPayload: BundlePayload;
  /**
   * The compiled payload with its guids translated to the engine's re-minted
   * ones — the artifact side of the comparison, showing only what the engine
   * normalizes on import.
   */
  readonly remappedPayload: BundlePayload;
  /** The command was run with `--verbose`; report at length. */
  readonly verbose: boolean;
  /** The project root every relative path resolves against. */
  readonly cwd: string;
  /** The running `@xano/sdk` version, for a plugin's own peer-range check. */
  readonly sdkVersion: string;
  /** This module's block from the project's `package.json` `"xanosdk"` object. */
  readonly config: Readonly<Record<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The plugin itself
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a toolchain module's `xanosdk.plugin` file default-exports.
 *
 * Five hooks, and deliberately no more. This contract was designed from one
 * example, and a contract designed from one example generalizes badly — so it
 * covers exactly what that first module needs and stops. The SECOND toolchain
 * module is the one that should generalize it, with the real second set of
 * requirements in hand.
 *
 * Every hook is optional: a module that only adds a `.gitattributes` line
 * declares {@link ToolchainPlugin.contributes} alone.
 *
 * ── Contract skew is refused, never absorbed ────────────────────────────────
 *
 * Because every hook is optional, a module written against an older shape of
 * this contract would load, register, and contribute NOTHING — silently, since
 * "a module with no contributions" is a legitimate outcome. So the SDK refuses
 * a plugin whose shape says it was built against a contract that no longer
 * exists, by name, with the upgrade to make:
 *
 * - a `files` hook and no `contributes` — `files` was renamed once the hook
 *   stopped running only at scaffold time. Rename it.
 * - a `ciSteps` entry in what `contributes` returns — the slot is gone. A
 *   module's own check already rides on `xanosdk export --frozen-lock` through
 *   {@link ToolchainPlugin.onBundle} with {@link BundleContext.frozen} set, so
 *   it needed no workflow step of its own. Drop it.
 */
export interface ToolchainPlugin {
  /**
   * Repeated from the manifest so the module and its `package.json` must
   * agree. A plugin whose default export does not say `"toolchain"` is refused
   * — the mismatch means one of the two is stale, and guessing which would run
   * code the manifest did not describe.
   */
  readonly kind: "toolchain";
  /** Questions added to the questionnaire, asked after the SDK's own. */
  readonly questions?: readonly PluginQuestion[];
  /**
   * What this module contributes to the project, given its answers.
   *
   * Runs whenever the project is reconciled — at `init`, when the module is
   * installed into an existing project, and when its questions are re-asked —
   * so it must be pure and must not look at the filesystem.
   */
  readonly contributes?: (answers: PluginAnswers) => ProjectContributions;
  /**
   * Read this module's stored config block back into the answers that produced
   * it — the inverse of {@link ToolchainPlugin.contributes}.
   *
   * `contributes` is a MODULE-PRIVATE transform: only you know that
   * `{ enabled: true, dir: "xanoscript" }` came from
   * `{ xanoscript: true, dir: "xanoscript" }`. The SDK will not guess, and
   * matching question ids to same-named config keys would be a convention this
   * contract does not state.
   *
   * Without it, a re-ask offers your shipped defaults — and non-interactively
   * ANSWERS with them — silently resetting a directory the user chose. So
   * declare it whenever your config keys are not your question ids.
   *
   * Optional. A module that omits it gets shipped defaults on a re-ask, and the
   * user is TOLD that is what happened rather than left to discover it. Keys
   * that match no declared question are ignored, and a throw is reported and
   * degrades to the defaults — this hook can never take a command down.
   */
  readonly answersFromConfig?: (config: Readonly<Record<string, unknown>>) => PluginAnswers;
  /** Runs on `export` and `deploy`, after compile and before the network call. */
  readonly onBundle?: (ctx: BundleContext) => Promise<HookResult>;
  /** Runs on `preflight`, contributing a comparison to the report. */
  readonly onPreflight?: (ctx: PreflightContext) => Promise<HookResult>;
}
