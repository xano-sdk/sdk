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
 * declare questions, contribute to files the project owns, add a section to
 * the route manifest (`routes.gen.ts`), and run when a bundle is compiled or a
 * workspace is checked.
 *
 * The contract was first built for a module that renders the compiled
 * workspace to a committed tree on every deploy, so a backend change can be
 * reviewed as what the engine will actually run. The route-manifest hook was
 * added for the second module, `@xano-sdk/zod`, which renders a runtime
 * validator for every request input beside the SDK's own input types.
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
// Route inputs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The request inputs of every endpoint, realtime channel and realtime message a
 * route manifest (`routes.gen.ts`) describes, read off the compiled payload.
 *
 * VALIDATOR-NEUTRAL on purpose. The SDK renders its own request types from this
 * and a module renders its validators from the same value, so the two cannot
 * disagree about what an input is: there is one reading of the stored inputs,
 * not one per renderer. It is built from the payload alone because the decode
 * paths (`pull`, `generate`, `init --from`) write the manifest with no compile
 * of the workspace to ask.
 *
 * Keys are the manifest's FINAL keys, so a section built from this lines up
 * with `ROUTES` and `CHANNELS` entry for entry. Entries are in a fixed order (see
 * each list), so a renderer that walks them in order writes the same text for
 * the same workspace.
 */
export interface RouteInputs {
  /** One per `ROUTES` key, in `ROUTES` order. */
  readonly routes: readonly RouteInputSet[];
  /** One per `CHANNELS` key, in `CHANNELS` order: the channel's path params. */
  readonly channels: readonly RouteInputSet[];
  /**
   * One per message on a channel in `CHANNELS`, sorted by key: the message's
   * payload. A message whose channel the manifest leaves out (its server's
   * canonical resolves nowhere) is left out with it.
   */
  readonly messages: readonly MessageInputSet[];
}

/** The inputs of one endpoint or channel, under its manifest key. */
export interface RouteInputSet {
  /**
   * The manifest key: `"GET listings"` or `"v1:GET vehicles"` for an endpoint,
   * `"rooms/{room_id}"` or `"chat:lobby"` for a channel.
   */
  readonly key: string;
  /** In the order the def declares them. */
  readonly inputs: readonly InputDescription[];
}

/**
 * The payload inputs of one realtime message. Its `key` is
 * `"<channel key> <message name>"` — `"rooms/{room_id} send"`. Read in the
 * order a message is addressed, and collision-free: a message name holds no
 * space and no `/`.
 */
export interface MessageInputSet extends RouteInputSet {
  /** The owning channel's `CHANNELS` key. */
  readonly channel: string;
  /** The message's name, as a client sends it. */
  readonly name: string;
}

/**
 * The stored input types whose description carries nothing beyond the common
 * flags. Engine spellings, not authoring names: `epochms` is
 * `input.timestamp()`, `blob_img` is `input.image()`, `file` is a raw upload.
 */
export type InputScalarType =
  | "text"
  | "int"
  | "decimal"
  | "bool"
  | "email"
  | "password"
  | "uuid"
  | "date"
  | "epochms"
  | "json"
  | "file"
  | "blob"
  | "blob_img"
  | "blob_video"
  | "blob_audio"
  | "geo_point"
  | "geo_multipoint"
  | "geo_linestring"
  | "geo_multilinestring"
  | "geo_polygon"
  | "geo_multipolygon";

/**
 * An enabled method on an input (`trim`, `min:8`), with its arguments as
 * strings. The stored form is numeric and string inconsistently (`[8]` and
 * `["8"]` are both real bytes), so the two are read as one.
 */
export interface InputMethod {
  readonly name: string;
  readonly args: readonly string[];
}

/**
 * A list input's length bounds. A bound the engine does not enforce is ABSENT,
 * never `0`: unset is stored as `""` or `{}`, and the engine reads `0` as no
 * bound too, so all of those describe the same unbounded side.
 */
export interface InputListBounds {
  readonly min?: number;
  readonly max?: number;
}

/** The flags every described input carries, whatever its type. */
export interface InputDescriptionBase {
  /** The key a client sends. */
  readonly name: string;
  /** A required input stays required when it carries a default. */
  readonly required: boolean;
  /**
   * Whether `null` is accepted. A type nullable by default (files, geo, uuid,
   * vector, `date`, `epochms`) reads `true` unless the def said otherwise, and
   * a `json` input is always nullable.
   */
  readonly nullable: boolean;
  /** `false` for a single value; the bounds for a list. */
  readonly list: false | InputListBounds;
  /**
   * The enabled methods, in stored order. Always empty on an `obj`, and on an
   * `enum` or `vector` input, whose methods the engine does not apply (a
   * dbLink's customization of such a column is the exception: the engine
   * applies those).
   */
  readonly methods: readonly InputMethod[];
}

/**
 * One request input.
 *
 * A `dbLink` is the one entry that is not itself a request key: the engine
 * expands it into the linked table's columns at the TOP level of the request,
 * so a renderer spreads {@link DbLinkInputDescription.columns} into the
 * surrounding object. A stored type this reading does not know is `unknown`,
 * never guessed at.
 */
export type InputDescription =
  | (InputDescriptionBase & { readonly type: InputScalarType })
  | (InputDescriptionBase & {
      readonly type: "enum";
      /** As stored: a numeric enum keeps numeric values. */
      readonly values: readonly (string | number)[];
    })
  | (InputDescriptionBase & { readonly type: "vector"; readonly size: number })
  | (InputDescriptionBase & {
      readonly type: "tableRef";
      /** The referenced table's primary-key type, which is what a client sends. */
      readonly keyType: "int" | "uuid";
      /** The referenced table's guid. */
      readonly table: string;
    })
  | (InputDescriptionBase & { readonly type: "obj"; readonly children: readonly InputDescription[] })
  | DbLinkInputDescription
  | (InputDescriptionBase & {
      readonly type: "unknown";
      /** The stored type string, for a renderer's diagnostics. */
      readonly storedType: string;
    });

/**
 * A database link: one stored input the engine expands into one input per
 * column of the linked table.
 */
export interface DbLinkInputDescription {
  /** The stored entry's name (by convention `<table>__`). Not a request key. */
  readonly name: string;
  readonly type: "dbLink";
  /** The linked table's guid. */
  readonly table: string;
  /**
   * The request inputs it expands to, as the engine expands them: never the
   * `id`, not a column the link hides, not a private or internal column unless
   * the link customizes it, and a customized column with the customization's
   * `required` and methods in place of its own.
   *
   * `undefined` when the payload does not carry the linked table, so the
   * columns cannot be known. A renderer must not read that as "no columns":
   * narrowing the request to nothing would reject a body the server accepts.
   */
  readonly columns: readonly InputDescription[] | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route-manifest sections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What {@link ToolchainPlugin.routesManifest} is handed.
 *
 * Everything the section can depend on is in here, and nothing else: the
 * hook's output is a function of this value alone (see the hook for why).
 */
export interface RoutesManifestContext {
  /**
   * Every endpoint's, channel's and message's request inputs, under the
   * manifest's FINAL keys — the keys of `ROUTES`, `CHANNELS` and the generated
   * input maps — in a fixed order. Walk it in order and the section comes out
   * the same for the same workspace.
   */
  readonly inputs: RouteInputs;
  /** This module's block from the project's `package.json` `"xanosdk"` object. */
  readonly config: Readonly<Record<string, unknown>>;
  /** The running `@xano/sdk` version, for a plugin's own peer-range check. */
  readonly sdkVersion: string;
}

/**
 * One module's section of `routes.gen.ts`: TypeScript source, plus the named
 * package imports it needs.
 *
 * WHERE IT LANDS. The SDK composes the file: the merged imports of every
 * module at the top (one `import { a, b } from "pkg";` per package, names
 * sorted and deduped), then the core sections, then each module's `source` in
 * a marked block naming the module's package and version, blocks ordered by
 * package name. So the source is in the SAME FILE as the core sections and
 * after them: it may name the generated types (`RouteInputs`, `ChannelInputs`,
 * `MessageInputs`, `MessageName` — maps keyed by the manifest's keys, not the
 * {@link RouteInputs} description type of this entry, and always present,
 * empty or not) directly, without importing them. Anything it exports is
 * exported from `routes.gen.ts`.
 *
 * ── Imports are declared, never written ─────────────────────────────────────
 *
 * The core sections import nothing, which is what keeps `routes.gen.ts` free
 * of the SDK runtime in a frontend bundle. A module's imports are the only
 * ones in the file, so they are data the SDK can check, never `import` lines
 * inside `source`. A specifier that is not a bare package name is REFUSED:
 * `@xano/sdk` and its subpaths (the bundle cost the file exists to avoid), a
 * relative or absolute path (it would resolve against whichever directory the
 * file was written into), and a protocol (`node:`) all fail the module by
 * name. Each name must be a plain identifier: no `as` renames, no
 * side-effect-only import.
 *
 * Imported names share one scope with the core sections and every other
 * module's source, so pick names that will not collide; a collision fails the
 * user's typecheck rather than being renamed for you.
 *
 * A blank `source` contributes no block at all, and its imports are dropped
 * with it: that is how a module whose config turns the section off removes it.
 */
export interface RoutesManifestSection {
  /** Named imports from packages the consuming project can resolve. */
  readonly imports?: readonly { readonly from: string; readonly names: readonly string[] }[];
  /** TypeScript placed after the core sections. Must not spell a block marker (`// xanosdk:begin`, `// xanosdk:end`). */
  readonly source: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The plugin itself
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a toolchain module's `xanosdk.plugin` file default-exports.
 *
 * Six hooks. The first five were designed from one example (a module that
 * renders the workspace to a committed tree) and covered exactly what it
 * needed. The sixth, {@link ToolchainPlugin.routesManifest}, was added when the
 * second module, `@xano-sdk/zod`, brought a second real set of requirements: a
 * module that writes into a file the SDK generates, rather than into a tree of
 * its own. A hook is added when a module needs it, not in anticipation.
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
  /**
   * This module's section of the route manifest (`routes.gen.ts`), computed
   * from the request inputs the SDK read off the payload. See
   * {@link RoutesManifestSection} for where it lands and what it may import.
   *
   * Runs wherever the manifest is written: `routes --emit` (the `xano:routes`
   * and `xano:check` scripts), `init` when it writes the project's first
   * manifest, the refresh `marketplace install`, `reinstall` and `remove`
   * make, and the decode paths `pull` and `generate`. Not `init --from`: a
   * project it creates has no module installed yet, and the first
   * `xano:routes` after an install adds the section.
   *
   * SYNCHRONOUS AND PURE. No filesystem, no network, no clock, no randomness:
   * the same context returns the same section, every time. Every writer of
   * `routes.gen.ts` must produce identical bytes for the same workspace, or
   * `routes --emit --strict` flips between red and green depending on which
   * command last wrote the file; and the decode paths place the file
   * synchronously, so a promise has nowhere to be awaited. A promise, or any
   * value that is not a {@link RoutesManifestSection}, is refused.
   *
   * A throw (or a refused section) is this module failing, not the manifest:
   * the core sections are still refreshed, the module's previous block is kept
   * as it was (none is written when the file has none yet), and a warning
   * names the module. A module that fails to load is handled the same way. On a verifying run
   * (`routes --emit --strict`) it is fatal instead, because a check that did
   * not run must not read as one that passed.
   */
  readonly routesManifest?: (ctx: RoutesManifestContext) => RoutesManifestSection;
}
