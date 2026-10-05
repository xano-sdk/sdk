/**
 * The CLI's command registry — the single source of truth for what `xanosdk`
 * accepts.
 *
 * Three consumers read this table and nothing else:
 *   • `help.ts`  renders global and command-scoped help from it,
 *   • `cli.ts`   validates the command/subcommand a user typed against it,
 *   • the unknown-* errors list valid verbs from it (never a hand-written string).
 *
 * The dispatch chain in `cli.ts` still owns the lazy `await import(...)` per
 * command — deliberately, so the browser-safe authoring bundle never pulls in
 * the Node-only OAuth/deploy stack. A drift test pins the registry's keys to the
 * commands that chain actually compares against, so the two cannot diverge
 * silently even though they are written twice.
 *
 * Keep this module free of `node:*` imports for the same bundling reason.
 */
import { sourceSpellings, type SourceKind } from "./source-selector.js";
import { suggest } from "../util/suggest.js";
import { fontIdsFor } from "./theme-presets.js";

export { suggest };

/** A flag's rendered spec plus its one-line description. */
export interface FlagSpec {
  /** How the flag is written, e.g. `--on <backend>`. */
  readonly spec: string;
  readonly summary: string;
  /** The set this flag accepts, when it has one — shell completion offers these. */
  readonly values?: readonly string[];
  /**
   * `values` are starting points, not the whole set: the flag takes others
   * too (`--theme` a URL or a path, `--radius` any CSS length). `help --json`
   * and the manifest then publish them as `examples`, never `values`.
   */
  readonly open?: true;
}

/** What a backend selector slot is FOR: read from, write to, run on, or act on. */
export type SelectorRole = "from" | "to" | "on" | "subject";

/**
 * What a slot means when nothing is typed into it.
 *
 * - `tracked` — the backend this project last deployed to.
 * - `entry` — `deploy`'s source only: the project's own entry file, compiled.
 * - `none` — the slot supplies nothing when absent: `generate` and `init --from`
 *   need a source named, and `deploy --to` absent means the deploy's own
 *   ephemeral or local path rather than any backend here.
 */
export type SelectorDefault = "tracked" | "entry" | "none";

/**
 * One backend selector slot, declared once on the flag or positional that takes
 * it. Help renders the spellings from `accepted`, completion offers its bare
 * kinds, the manifest publishes it, the parse-arm error for a missing value
 * lists it, and `backend-slot.ts` parses with it — so a command cannot accept a
 * kind its help does not show.
 *
 * `refused` names kinds that belong to the grammar but that THIS command cannot
 * serve, each with the reason. They stay out of `accepted` (help does not offer
 * them) and are refused with the reason rather than as unknown — an unknown
 * kind reads as a typo, and the reason is what tells the reader whether to name
 * another backend or reach for another command.
 */
export interface SelectorSpec {
  readonly accepted: readonly SourceKind[];
  readonly role: SelectorRole;
  readonly default: SelectorDefault;
  readonly refused?: Readonly<Partial<Record<SourceKind, string>>>;
}

/**
 * A command's reference to a flag: the {@link FLAGS} key, or the key plus a
 * summary that replaces the shared one. Several flags genuinely mean different
 * things per command — `--force` skips a confirmation for `ephemeral delete` but
 * overwrites a non-empty directory for `init` — and a scoped help page that
 * describes the wrong one is worse than no help at all.
 */
export type FlagRef =
  | string
  | {
      readonly key: string;
      readonly summary: string;
      /**
       * How THIS command writes the flag, when it takes a value the shared one
       * does not.
       */
      readonly spec?: string;
      /**
       * The closed set THIS command accepts, when it is narrower or wider than
       * the shared one — so a completion never offers a value the command
       * refuses on principle.
       */
      readonly values?: readonly string[];
      /**
       * This flag is the command's backend selector slot. `summary` is then the
       * lead only — the accepted spellings are appended from `accepted` wherever
       * the flag is rendered, so there is no hand-copied list to go stale.
       */
      readonly selector?: SelectorSpec;
    };

/** A positional argument in a usage line. */
export interface ArgSpec {
  readonly name: string;
  readonly required: boolean;
  /** This argument names a file or directory — shell completion offers paths for it. */
  readonly path?: boolean;
  /**
   * Flags that stand in for this argument, so an invocation carrying one of them
   * is complete without it — `xanosdk deploy --bundle ws.json` ships an
   * already-exported bundle and takes no entry file. `required` still describes
   * the plain form, which is what `display` and the usage line show.
   */
  readonly satisfiedBy?: readonly FlagKey[];
  /** The closed set this argument accepts, when it has one — shell completion offers these. */
  readonly values?: readonly string[];
  /**
   * This argument soaks up every remaining token, so the command has no maximum
   * positional count. Declared here rather than special-cased in `cli.ts`
   * because the arity check that rejects a stray positional reads its budget
   * from this table alone — an unmodelled variadic would start failing real
   * invocations (`marketplace search ai agent`, `lock prune ./index.ts a b`).
   *
   * Only ever the LAST argument: anything after it would be unreachable.
   */
  readonly variadic?: boolean;
  /** This positional is the command's backend selector slot — see {@link SelectorSpec}. */
  readonly selector?: SelectorSpec;
}

/**
 * A command's positionals as its usage line writes them — `<file> [keys…]`.
 * Lives here, with the table it reads, because two consumers render it: the
 * help page and the "unexpected argument" error that says what WOULD have fit.
 */
export function renderArgs(args: readonly ArgSpec[] | undefined): string {
  // An argument a flag can stand in for (`satisfiedBy`) is optional as typed.
  return (args ?? []).map((a) => (a.required && a.satisfiedBy === undefined ? `<${a.name}>` : `[${a.name}]`)).join(" ");
}

/** A verb under a noun command (`workspace details`, `ephemeral list`). */
export interface SubcommandSpec {
  readonly summary: string;
  readonly args?: readonly ArgSpec[];
  /** Keys into {@link FLAGS}, optionally with a command-specific summary. */
  readonly flags?: readonly FlagRef[];
  readonly example?: string;
  /** See {@link CommandSpec.extraArgHint}. */
  readonly extraArgHint?: string;
  /** See {@link CommandSpec.unreleasedFlags} — the verb-level counterpart. */
  readonly unreleased?: true;
  /**
   * Surface this verb as its own row in a global-help group other than its
   * parent's, for a verb that reads as a task in its own right rather than as
   * something you would think to look for under its noun.
   */
  readonly group?: HelpGroup;
  /** The name column for that row (required whenever `group` is set). */
  readonly display?: string;
  /** A one-line summary for that row, when the verb's own reads oddly out of context. */
  readonly groupSummary?: string;
  /**
   * See {@link CommandSpec.deferUnknownFlags} — the VERB-level counterpart, and
   * the level a noun command must declare it at.
   *
   * `marketplace` cannot declare it: `list`, `search` and `details` hand-refuse
   * only `--prompt`, so a command-level deferral would make `marketplace list
   * --tpyo` parse cleanly and be discarded — a flag-safety regression across
   * three shipped verbs, delivered as a side effect of a fourth growing plugin
   * flags. Only the verbs that RUN a questionnaire defer, and they carry the
   * same obligation: refuse whatever nothing claimed, on every exit path.
   */
  readonly deferUnknownFlags?: true;
}

/** A top-level command. */
export interface CommandSpec {
  /** Which global-help group it renders under. */
  readonly group: HelpGroup;
  readonly summary: string;
  /** The name column in global help, e.g. `deploy <file>`. */
  readonly display: string;
  readonly args?: readonly ArgSpec[];
  /** Keys into {@link FLAGS}, optionally with a command-specific summary. */
  readonly flags?: readonly FlagRef[];
  readonly subcommands?: Readonly<Record<string, SubcommandSpec>>;
  readonly example?: string;
  /** A sentence about behaviour help should state, rendered under its own heading — never under the example. */
  readonly notes?: string;
  /**
   * Appended to the "unexpected argument" failure when a stray positional is
   * more likely a misunderstanding of what the command DOES than a typo —
   * `marketplace list chat` reads as a filter, `workspace export ./index.ts` as a
   * local compile. Counting arguments would be a true but useless answer there,
   * so the sentence that redirects lives with the command it describes rather
   * than in the parser.
   */
  readonly extraArgHint?: string;
  /** Hidden from global help (aliases). Still resolvable for `--help` and dispatch. */
  readonly aliasOf?: string;
  /**
   * Flags that WORK but are withheld from every discovery surface — help,
   * shell completion, and the did-you-mean suggestions — because the feature
   * they drive is not ready to be announced yet.
   *
   * Distinct from {@link removed}, which is for a surface that is gone and
   * fails loudly when typed. An unreleased flag parses and runs exactly as it
   * always did; it is simply not advertised, so nobody discovers a half-landed
   * feature from `--help` and files a bug against it. Anyone who already knows
   * the flag (us) can still drive it.
   *
   * TEMPORARY BY CONSTRUCTION: this list is meant to shrink to nothing. Delete
   * the entry — not the flags — when the feature is announced.
   */
  readonly unreleasedFlags?: readonly string[];
  /**
   * This command accepts flags the registry cannot know about, so the parser
   * carries its unrecognized ones through instead of refusing them, and the
   * command refuses whatever nothing claimed.
   *
   * `init` is the case: an installed toolchain module contributes questions,
   * each of which derives a flag that answers it non-interactively — and the
   * modules are not discovered until `init` has a target directory and has
   * installed them, which is long after parsing.
   *
   * Declared here rather than compared by name in the parser so the next
   * command to grow plugin flags does not edit the parser, and so help and
   * completion can see the property.
   *
   * A command that sets this takes on an OBLIGATION: it must refuse the
   * leftovers on every exit path. `parseArgs` has deferred the check, not
   * cancelled it — an accepted-and-discarded flag would slip back in through
   * the door built to close it.
   */
  readonly deferUnknownFlags?: true;
}

/** Global-help group titles, in render order. */
export const HELP_GROUP_ORDER = [
  "Author",
  "Deploy",
  "Environments",
  "Account",
  "Maintenance",
] as const;

export type HelpGroup = (typeof HELP_GROUP_ORDER)[number];

/**
 * Every flag the CLI parses, described once. Commands reference these by key so
 * the shared ones (`--lock`, `--origin`, `--config`, `--local-auth`) read identically
 * everywhere they appear.
 */
export const FLAGS = {
  out: { spec: "--out, -o <path>", summary: "Write the artifact to this path instead of stdout (`-` is stdout)" },
  lock: { spec: "--lock[=<path>]", summary: "Name the xano.lock to use — default: beside the entry file" },
  "no-lock": { spec: "--no-lock", summary: "Build with no lock: identities derive from names, public URLs are left to the instance" },
  entry: {
    // `--entry <path>` and `--entry=<path>` both parse; the spaced spelling is
    // what makes completion offer files after it.
    spec: "--entry <path>",
    summary: "Workspace entry to resolve xano.lock beside (for lock subcommands that take no entry file)",
  },
  "frozen-lock": { spec: "--frozen-lock", summary: "CI guard: fail instead of changing the lock, or on a lock entry nothing matches" },
  "allow-lock-orphans": {
    spec: "--allow-lock-orphans",
    summary: "With --frozen-lock: accept lock entries no exported object matches, for a workspace adopted with `lock import` and ported a piece at a time",
  },
  strict: { spec: "--strict", summary: "Promote every export warning (data-losing shapes, unresolvable filters) to a hard failure" },
  yes: { spec: "--yes, -y", summary: "Confirm a destructive action non-interactively" },
  bundle: { spec: "--bundle <path>", summary: "Use an already-exported bundle instead of an entry file" },
  reset: {
    spec: "--reset",
    summary: "Replace the environment and re-seed it, overriding --keep-data (a deploy without --keep-data already does)",
  },
  "keep-data": {
    spec: "--keep-data",
    summary:
      "Keep the environment's table rows: merge into what an earlier deploy filled instead of replacing it. Seed rows are not re-written, objects removed from the project are deleted, and a new or never-filled environment is replaced and seeded as usual. --reset overrides it; --to already merges",
  },
  // `test`'s selector. It was `--env`, which read as "an environment variable"
  // beside `--env-var`/`--backend-env-file` and named only two of the backend kinds.
  // Its accepted spellings and completion values come from the slot declared
  // on each `test` verb, not from this row.
  on: {
    spec: "--on <backend>",
    summary: "Run on this backend instead of the one this project last deployed to",
  },
  kind: {
    spec: "--kind <unit|workflow>",
    summary: "Only this test family (default: both)",
    values: ["unit", "workflow"],
  },
  concurrency: {
    spec: "--concurrency <n>",
    summary:
      "Run this many tests at once (default: 1). Tests share the environment database, so raise it only when yours do not depend on shared state.",
  },
  "expires-hours": { spec: "--expires-hours <n>", summary: "Ephemeral TTL at create time, 1–24 (default: 1)" },
  static: { spec: "--static <dir>", summary: "Archive this built frontend and deploy it to the static host" },
  ephemeral: {
    spec: "--ephemeral",
    summary: "Deploy to a disposable ephemeral on Xano's cloud instead of the Xano Engine on this machine",
  },
  "local": {
    spec: "--local[=<version|url|path>]",
    summary:
      "Deploy to the Xano Engine on this machine — the default, so the flag is needed only to name an engine. Bare: runs the project's pinned engine version (the latest on first run, then pinned in package.json — commit it); a newer engine is offered, never applied without a yes. A version, URL or archive path (or XANOSDK_ENGINE_OVERRIDE, for every run in a shell) runs that engine as an override and never touches the pin; a URL must be https (plain http only from this machine). Not combinable with --to or --ephemeral",
  },
  // Keyed apart from the global `version` row: that one is the first-argument
  // `xanosdk --version`, this one a value an engine verb takes after the verb.
  "engine-version": {
    spec: "--version <v>",
    summary: "An engine version, like v0.1.5 (the leading v is optional)",
  },
  "no-dev-env": {
    spec: "--no-dev-env",
    summary:
      "Do not point this project's .env.local at the deployed backend (only written when no static site is published)",
  },
  "static-env": { spec: "--static-env KEY=VALUE", summary: "Public config baked in as window.<KEY> (repeatable; never secrets)" },
  "env-var": {
    spec: "--env-var KEY=VALUE",
    summary:
      "Set one BACKEND workspace env var for this run (repeatable). Beats xano/.env and --backend-env-file; the value never touches disk",
  },
  "backend-env-file": {
    spec: "--backend-env-file <path>",
    summary:
      "Read backend env values from this dotenv-style file INSTEAD of the default xano/.env (for CI, which does not have the ignored default)",
  },
  "allow-empty-env": {
    spec: "--allow-empty-env=NAME[,NAME]",
    summary:
      "Send these declared names EMPTY when no value is supplied, clearing them in whatever imports the bundle. Only `deploy` refuses without it; per-name on purpose, and a bare --allow-empty-env is refused",
  },
  "allow-empty-doc-token": {
    spec: "--allow-empty-doc-token=<scope>",
    summary:
      "Send this scope's documentation token EMPTY when none is supplied, clearing that doc site's gate in whatever imports the bundle — `workspace`, or an API group's name. Repeat for more than one. Without it `deploy` refuses any gate left with no token, and every build refuses one on a group that publishes its docs (`swagger` on); a bare --allow-empty-doc-token is refused",
  },
  "secrets-file": {
    spec: "--secrets-file <path>",
    summary:
      "Read documentation tokens from this file INSTEAD of the default xano/.secrets.json (for CI, which does not have the ignored default)",
  },
  "doc-token": {
    spec: "--doc-token <scope>=<value>",
    summary:
      "Supply one documentation token inline — `workspace=…`, or an API group's name. Repeat for more than one. Prefer --secrets-file: a value here is visible in shell history, the process list, and any CI log that echoes the command",
  },
  "no-secrets": {
    spec: "--no-secrets",
    summary:
      "Find the documentation tokens and write none — for a machine where a secret on disk is not wanted. The tree still declares the gates, so a later deploy refuses rather than clearing one",
  },
  export: {
    spec: "--export <name>",
    summary: "The named export to compile, when the module exports several defs",
  },
  emit: {
    spec: "--emit <path>",
    summary: "Write a generated route + socket module there (plain data, no SDK import; `-` is stdout)",
  },
  "static-host": { spec: "--static-host <name>", summary: "Static-host name to deploy to (default: default)" },
  "static-routing": {
    spec: "--static-routing spa|multipage",
    summary: "Override URL resolution (inferred from the bundle; rarely needed)",
    values: ["spa", "multipage"],
  },
  test: {
    spec: "--test",
    summary:
      "After deploying, run the environment's tests; exit 5 if one fails, 6 if they cannot be reached; the deploy stands either way",
  },
  // Three flags where there was one. `--no-verify` meant a post-deploy liveness
  // probe, an offline round-trip diff, and "do not load the entry file" — three
  // unrelated checks whose only shared property was the word "verify", so the
  // one summary had to say "instead" mid-sentence and a reader had to know
  // which command they were on to know what they were turning off.
  "skip-liveness": {
    spec: "--skip-liveness",
    summary: "Do not wait to confirm the deploy came up (static host, microservices)",
  },
  "skip-roundtrip": {
    spec: "--skip-roundtrip",
    summary: "Do not check that the written tree re-exports as it was pulled (offline; no network, no deploy)",
  },
  "identity-only": {
    spec: "--identity-only",
    summary: "Act on the named lock entries without loading the entry file",
  },
  "require-microservices": {
    spec: "--require-microservices",
    summary: "Fail the deploy (exit 4) when a microservice is not ready by the end of the wait",
  },
  report: {
    spec: "--report <grouped|full|json>",
    summary: "Findings as grouped root causes (default), every site, or JSON",
    values: ["grouped", "full", "json"],
  },
  origin: {
    spec: "--origin <origin>",
    summary: "Xano OAuth host for `login` and a XANO_REFRESH_TOKEN exchange (default: $XANO_ORIGIN)",
  },
  config: { spec: "--config <path>", summary: "Explicit credential file (default: $XANO_CONFIG)" },
  "local-auth": { spec: "--local-auth", summary: "Use the project-local ./.xano/auth.json instead of the shared cache" },
  profile: {
    spec: "--profile, -p <name>",
    summary:
      "Commands that sign in: which stored credential profile to act as — the only thing that overrides this project's xano.profile.json (then $XANO_PROFILE, then the credential file default)",
  },
  all: { spec: "--all", summary: "Every stored profile, not just the active one" },
  "all-workspaces": { spec: "--all-workspaces", summary: "Enumerate across every workspace, not just the token's" },
  guest: { spec: "--guest, -g", summary: "Mint a read-only guest session (browse only)" },
  "url-only": { spec: "--url-only, -u", summary: "Print the dashboard URL instead of opening a browser" },
  prompt: { spec: "--prompt", summary: "Print only the add-on wiring prompt, for piping to a coding agent" },
  port: { spec: "--port <n>", summary: "Loopback callback port (default: 47100)" },
  "workspace-id": { spec: "--workspace-id <n>", summary: "Numeric workspace the meta API token acts on" },
  paste: {
    spec: "--paste",
    summary:
      "Sign in without the loopback callback: open the printed URL in any browser and paste the redirect back. " +
      "For a host whose 127.0.0.1 the browser cannot reach — remote shell, container, Codespace. Needs a terminal.",
  },
  scope: { spec: "--scope \"<list>\"", summary: "OAuth scopes to request (default: the built-in set)" },
  runtime: { spec: "--runtime", summary: "After the round-trip, run each deployed function and report" },
  capture: { spec: "--capture", summary: "Write each round-tripped function's fetched JSON" },
  "legacy-runtime": { spec: "--legacy-runtime", summary: "Remove the runtime copy earlier versions left in your own cache directory" },
  verbose: { spec: "--verbose", summary: "Print full diffs and raw engine detail" },
  instance: { spec: "--instance <url>", summary: "Override XANO_VALIDATE_INSTANCE for this run" },
  format: {
    spec: "--format <json|multidoc>",
    summary:
      "Which artifact to emit: json (default), or multidoc (the backend as XanoScript, rendered by the engine)",
    values: ["json", "multidoc"],
  },
  path: { spec: "--path <p>", summary: "Output location — `-` for stdout, a dir, or a file path" },
  name: { spec: "--name <n>", summary: "Name for what this command produces" },
  framework: {
    spec: "--framework <id>",
    summary: "Frontend framework to scaffold: react (default), svelte",
    values: ["react", "svelte"],
  },
  theme: {
    spec: "--theme <id>",
    summary:
      "shadcn/ui theme — <base> or <base>-<accent> (e.g. zinc-blue), a registry theme URL, or a registry item JSON path; an unknown id lists every base and accent",
    // Completion offers the base colors alone — the accent half multiplies them
    // into 126 values, which is a menu no one reads at a tab-complete prompt.
    // `--help` carries the accent list; this carries the starting points.
    values: ["neutral", "stone", "zinc", "mauve", "olive", "mist", "taupe"],
    open: true,
  },
  radius: {
    spec: "--radius <len>",
    summary: "Corner radius for the scaffold's theme — a number of rem (0, 0.5, 1) or a CSS length",
    values: ["0", "0.25", "0.5", "0.625", "0.75", "1"],
    open: true,
  },
  dark: {
    spec: "--dark <mode>",
    summary:
      "What switches the app into its dark palette: system (default, follows the OS), toggle (adds a control), off",
    values: ["system", "toggle", "off"],
  },
  font: {
    spec: "--font <id>",
    summary:
      "Body typeface — sans faces only (mono: --font-mono; serif: --font-heading), self-hosted from its @fontsource package (default: the system stack)",
    values: fontIdsFor("sans"),
  },
  "font-mono": {
    spec: "--font-mono <id>",
    summary: "Code typeface — mono faces only (default: the system mono stack)",
    values: fontIdsFor("mono"),
  },
  "font-heading": {
    spec: "--font-heading <id>",
    summary: "Heading typeface, any face, bound to h1–h6 (default: inherits the body face)",
    values: fontIdsFor("heading"),
  },
  icons: {
    spec: "--icons <id>",
    summary: "Icon set: lucide (default), tabler, phosphor",
    values: ["lucide", "tabler", "phosphor"],
  },
  "no-agents-md": { spec: "--no-agents-md", summary: "Do not write the AGENTS.md agent brief" },
  ai: {
    spec: "--ai <preset|none>",
    summary: "For scripted callers: `none` is --no-agents-md; any other value (an agent name) writes the one AGENTS.md every agent reads",
  },
  marketplace: {
    spec: "--marketplace <pkgs>",
    summary:
      "Marketplace modules to install and register, comma-separated, by the names `marketplace install` takes (auth resolves to @xano-sdk/auth); a name the marketplace does not list exits 8 before anything is written. An add-on install or the project npm install that fails exits 2 with the project left in place",
  },
  // `--from` and `--to` are every read's and every write's selector. Which
  // backends each command takes is declared on its own reference (a
  // `selector`), so these shared rows carry no spelling list and no values.
  from: {
    spec: "--from <source>",
    summary: "The backend to read from",
  },
  to: {
    spec: "--to <destination>",
    summary: "The backend to write to",
  },
  description: {
    spec: "--description <text>",
    summary: "What this release is for",
  },
  release: {
    spec: "--release <name>",
    summary: "The release this frontend belongs to — checked to exist and reported with the publish",
  },
  web: {
    spec: "--web",
    summary: "Collect the scaffold options in a browser instead of on the command line",
  },
  check: {
    spec: "--check",
    summary: "Report whether an upgrade is available and exit 7, without installing it",
  },
  /**
   * One meaning, everywhere: OVERWRITE something that already exists.
   *
   * `--yes` is the other half of the pair and means "do not ask me". They were
   * synonyms on three commands, where `--force` bought a second spelling for a
   * confirmation prompt and nothing else — so a reader could not tell, from the
   * flag alone, whether a command was going to overwrite anything. No command
   * takes both.
   */
  force: { spec: "--force", summary: "Overwrite something that already exists" },
  "backend-dir": {
    spec: "--backend-dir <path>",
    summary:
      "The backend directory to act on, when this project does not keep it in xano/ and nothing on disk says so",
  },
  "no-install": { spec: "--no-install", summary: "Skip the post-scaffold npm install" },
  "dry-run": { spec: "--dry-run", summary: "Print what would change and exit without sending it" },
  prune: { spec: "--prune", summary: "Also delete workspace objects your project no longer defines" },
  "reset-data": { spec: "--reset-data", summary: "Empty every table the bundle carries before importing" },
  seed: { spec: "--seed", summary: "Write the bundle's table rows (off by default; `--replace` always writes them)" },
  table: {
    spec: "--table <guid>",
    summary: `Which table to act on, by guid (repeatable) — \`${tablesCommand("workspace")}\` lists them`,
  },
  write: {
    spec: "--write",
    summary: "Actually perform the write — without it this is a dry run that changes nothing",
  },
  replace: {
    spec: "--replace",
    summary: "Wipe the workspace — including ALL its branches — and import in its place",
  },
  branch: {
    spec: "--branch <label>",
    summary: "Release to this branch instead of the live one (stages logic; schema is shared)",
  },
  "set-live": { spec: "--set-live", summary: "Promote the branch to live once the import lands" },
  "expect-live": {
    spec: "--expect-live <label>",
    summary:
      "With --set-live: refuse unless <label> is live — checked before landing and again before switching (not atomic)",
  },
  "to-profile": {
    spec: "--to-profile <name>",
    summary: "The stored credential profile whose instance and workspace receive the release",
  },
  "allow-shared-schema-changes": {
    spec: "--allow-shared-schema-changes",
    summary: "Proceed even though table/microservice changes reach every branch",
  },
  "allow-branch-deletion": {
    spec: "--allow-branch-deletion",
    summary: "Acknowledge that --replace permanently deletes the workspace's other branches",
  },
  "backup-branch": {
    spec: "--backup-branch[=<label>]",
    summary: "Snapshot the live branch's logic first; set-live back restores logic, not tables (shared by every branch)",
  },
  open: { spec: "--open", summary: "Open the deployed URL in your browser when it lands" },
  // ── Global (accepted by every command; see GLOBAL_FLAGS) ───────────────
  json: {
    spec: "--json",
    summary: "Force JSON on stdout (default: whenever stdout is not a terminal, a failure's document too — except help, `version`, which stays text for `$(xanosdk version)`, and a command whose stdout is its data, such as `export` or `--path -`)",
  },
  "no-refresh": {
    spec: "--no-refresh",
    summary: "Do not refresh the managed block in AGENTS.md",
  },
  help: { spec: "--help, -h", summary: "Show help for the command and exit" },
  version: { spec: "--version, -v", summary: "Print the CLI version and exit" },
} as const satisfies Record<string, FlagSpec>;

export type FlagKey = keyof typeof FLAGS;

/**
 * Flags the CLI accepts whatever the command, rendered as their own block in
 * global help rather than repeated on every command page.
 *
 * `--json` is parsed in `parseArgs` and read through `isMachineOutput`; `--help`
 * and `--version` are resolved from the raw argv before dispatch;
 * `--no-refresh` suppresses the agent-guidance refresh a compile does as a
 * courtesy, for anyone who wants a build that provably writes nothing outside
 * its output. It is global because the compile sits behind four commands. They live in
 * {@link FLAGS} like everything else so help and shell completion describe them
 * from the same one row each.
 */
export const GLOBAL_FLAGS = [
  "json",
  // Global rather than part of the shared AUTH bundle: it occupies ONE help row
  // here, against one on each of ~35 authenticated commands' manifest entries.
  // Commands that cannot honour it REFUSE it (see the post-loop cross-check in
  // `parseArgs`) rather than accepting and ignoring it.
  "profile",
  "no-refresh",
  "help",
  "version",
] as const satisfies readonly FlagKey[];

/** Flags every authenticated command accepts, via `getAccessToken`. */
const AUTH = ["origin", "config", "local-auth"] as const;

/**
 * The credential-FILE flags alone, for the commands that manage stored profiles
 * without resolving one to a bearer (`profile *`, `logout`). `--origin` names
 * the OAuth host a sign-in or a `XANO_REFRESH_TOKEN` exchange talks to; these
 * commands do neither — a revoke goes to the host stored with the profile — so
 * advertising it there was a flag accepted and ignored.
 */
const CREDENTIAL_FILE = ["config", "local-auth"] as const;

/**
 * Does this command reach a credential at all?
 *
 * Derived from the registry rather than listed: `--config` belongs to the
 * shared {@link AUTH} bundle and nothing else declares it, so a command added
 * later is classified by the bundle it already opted into and this cannot go
 * stale. It is what decides whether `--profile` is honoured or refused.
 */
export function isAuthenticatedCommand(command: string | undefined, subcommand: string | undefined): boolean {
  return flagRefFor(command, subcommand, "config") !== undefined;
}

/**
 * The `profile` verbs whose positional `<name>` IS the profile they act on. A
 * `--profile` beside it selects nothing — `profile set-default X -p ghost` set
 * X and exited 0 — so they refuse it, and their help does not offer it.
 */
const PROFILE_BY_NAME = ["add", "use", "set-default", "delete"];

/** Does this command honour `--profile`? Authenticated, and not a verb that takes the name positionally. */
export function takesProfileFlag(command: string | undefined, subcommand: string | undefined): boolean {
  if (command === "profile" && subcommand !== undefined && PROFILE_BY_NAME.includes(subcommand)) return false;
  return isAuthenticatedCommand(command, subcommand);
}

/**
 * The kind sets the selector slots below declare.
 *
 * Literals rather than imports of `CUT_KINDS`/`BACKEND_KINDS`: this module is
 * evaluated inside the `source-selector.ts` → `errors.ts` → `commands.ts`
 * cycle, where a value import is still uninitialised when `COMMANDS` is built.
 * `command-registry.test.ts` pins both to the constants, so the copy cannot
 * drift.
 */
const CUT = ["workspace", "ephemeral", "tenant"] as const satisfies readonly SourceKind[];
const BACKEND = ["workspace", "ephemeral", "local", "tenant"] as const satisfies readonly SourceKind[];

/**
 * `test`'s one slot: which backend a suite runs on. Running a test only reads
 * and reports, so every running backend is a legitimate target — the real
 * workspace included.
 */
const TEST_ON: FlagRef = {
  key: "on",
  summary: "Run on this backend instead of the one this project last deployed to",
  selector: { accepted: BACKEND, role: "on", default: "tracked" },
};

/** `test list` runs nothing: its `--on` says where it reads the suite from. */
const TEST_LIST_ON: FlagRef = {
  ...TEST_ON,
  summary: "List the tests on this backend instead of the one this project last deployed to",
};

/**
 * The commands that REFUSE a compile whose declared env names have no value.
 *
 * Every compile resolves `xano/.env` identically; what differs is what the
 * bytes are then used for. `deploy` imports them into an environment someone
 * keeps, and an import REPLACES the target's env set — so an unsupplied
 * declared name overwrites a live value with `""`. `export` writes a file,
 * `preflight` imports into a throwaway tenant it creates itself, and `release
 * create` cuts from what is already running, so all three report instead.
 *
 * Declared HERE, beside the flags, rather than as a string test at the compile
 * site: this is a property of a COMMAND, and a command added later that also
 * imports locally-compiled bytes has to be added to this set deliberately
 * instead of landing in the non-refusing branch by default. The scoping is also
 * the safety story — a refusal on a harmless command trains everyone to pass
 * the opt-out by reflex, and that habit follows them to the deploy that does
 * destroy data.
 */
export const REFUSES_EMPTY_ENV: ReadonlySet<string> = new Set(["deploy"]);

/**
 * The same set, for documentation tokens.
 *
 * Deliberately a second name rather than a reuse of the one above. The two sets
 * happen to hold the same command today and answer the same question — which
 * command IMPORTS these bytes into an environment someone keeps — but they are
 * about different destruction: one clears a backend's env values, the other
 * clears a doc site's gate. A future command that must refuse on one and not the
 * other should be expressible without unpicking a shared constant.
 */
export const REFUSES_EMPTY_DOC_TOKEN: ReadonlySet<string> = new Set(["deploy"]);

/**
 * The three flags that carry backend env VALUES into a compile.
 *
 * Named as a set because they are one family — the values a compile resolves
 * from outside the source — and because `release create` needs to re-describe
 * exactly these without restating the rest of {@link COMPILE}.
 *
 * Two files, not one, and which secret goes in which is decided by how it is
 * ADDRESSED: a backend variable by NAME (`--env-*`), a documentation token by
 * the OBJECT that holds it (`--secrets-file` / `--doc-token`).
 */
const ENV_VALUE_FLAGS = [
  "env-var",
  "backend-env-file",
  "allow-empty-env",
  "allow-empty-doc-token",
  "secrets-file",
  "doc-token",
] as const;

/**
 * Where `env set` / `env unset` write: the backend named with `--to`, or the
 * one this project last deployed to. Shared so the two verbs cannot drift into
 * different spellings. A Xano Engine is `--to local` — the boolean
 * `--local` these verbs once took is a rename error in the parser.
 */
const ENV_VAR_TARGET_FLAGS: readonly FlagRef[] = [
  {
    key: "to",
    summary: "Write to this backend instead of the one this project last deployed to",
    selector: { accepted: BACKEND, role: "to", default: "tracked" },
  },
  { key: "yes", summary: "Skip the confirmation a workspace or tenant write asks for (required when there is no terminal)" },
];

/**
 * Flags every command that compiles an entry file accepts, via `compileBundle`.
 *
 * The `--env-*` family lives HERE rather than on a hand-maintained list of
 * commands: every compile resolves `xano/.env` the same way, so a compile site
 * added later inherits the flags instead of silently shipping without them. A
 * hand-maintained list is how `preflight` ended up compiling local entries while
 * registering none of these flags.
 */
const COMPILE = [
  "lock",
  "no-lock",
  "frozen-lock",
  "allow-lock-orphans",
  "strict",
  ...ENV_VALUE_FLAGS,
] as const;

/**
 * The LOCK half of {@link COMPILE}, which `release create` does not take.
 *
 * These four only ever reach the comparison's compile, and there they can only
 * break it. `--no-lock` is refused over any lock that parses, and
 * `--frozen-lock` fails when no lock exists for a source with identities to
 * record — so on a project with a
 * committed lock, which is every project worth cutting a release from, offering
 * `--no-lock` hands the author a flag that turns the guard OFF while still
 * looking like it ran: not a check that silently cannot run, but a check the
 * help page invites you to disable by accident.
 *
 * Dropped rather than accepted-and-cleared, because a flag nobody can pass needs
 * no defensive handling downstream. `--lock` goes with them: pointing the
 * comparison at a different lock changes which identities it derives and so
 * reports divergence the release does not have.
 */
const COMPARISON_LOCK_FLAGS: readonly string[] = [
  "lock",
  "no-lock",
  "frozen-lock",
  "allow-lock-orphans",
];

/**
 * {@link COMPILE} as `release create` takes it.
 *
 * A release's bytes come from something that RAN, so `xano/.env` has no bearing
 * on them — but the convergence comparison DOES compile locally, and that
 * compile has to resolve env the way every other compile does or it reports a
 * difference the release does not have. The env flags are therefore accepted and
 * re-described, rather than omitted and silently ignored. The lock flags are the
 * opposite case and are dropped outright — see {@link COMPARISON_LOCK_FLAGS}.
 *
 * The suffix names the comparison rather than a flag. It used to say "the
 * optional `--bundle` comparison" while `--bundle` appeared nowhere on this
 * page — seven rows pointing at a trigger the reader had no advertised way to
 * reach, which is how a comparison that never ran stayed invisible.
 */
const COMPILE_COMPARISON_ONLY: readonly FlagRef[] = COMPILE.filter(
  (key) => !COMPARISON_LOCK_FLAGS.includes(key),
).map((key) =>
  ENV_VALUE_FLAGS.includes(key as (typeof ENV_VALUE_FLAGS)[number])
    ? {
        key,
        // The shared summary's trailing punctuation is not load-bearing for
        // another command's help text: normalize it before appending.
        summary: `${FLAGS[key].summary.replace(/[.\s]+$/, "")}. Applies ONLY to the local-compile comparison this command runs against the source — the released bytes come from what is running`,
      }
    : key,
);

/** Flags every scaffold-writing form of `init` shares, filled or empty. */
const SCAFFOLD = [
  { key: "name", summary: "Project name (default: the target directory's basename)" },
  "framework",
  "theme",
  "radius",
  "dark",
  "font",
  "font-mono",
  "font-heading",
  "icons",
  "no-agents-md",
  "ai",
  {
    key: "force",
    summary:
      "Write into a non-empty target directory. Over an existing project it lists every file it would overwrite and confirms first (--yes without a terminal); files the scaffold does not write are kept",
  },
  "no-install",
] as const satisfies readonly FlagRef[];

/**
 * The one wording of the guid stability guarantee, shared by every surface that
 * offers guid selection.
 *
 * Two summaries state it — the `--seed` flag and the `tables` verb — and a
 * guard asserts it in each. Hand-copied, a reword in one place diverges
 * silently from the other; interpolated, a new guid-bearing surface has
 * the sentence available rather than having to remember it.
 *
 * It reads as a GUARANTEE rather than a caveat because a deploy preserves the
 * archive's guids, which is what makes selecting by guid worth offering: the
 * value survives into a script or a frontend. What still moves it is a RENAME,
 * since a derived guid seeds from the name.
 */
export const GUID_STABILITY_NOTE =
  "Guids survive a redeploy, so one written down earlier keeps matching — and a rename whose xano.lock entry moves with it (`lock rename`) keeps it too; one the lock is not told about gives the table a new guid";

/**
 * How every message and summary names the listing that shows a backend's
 * table guids: `xanosdk tables ephemeral:pr-3`, or `xanosdk tables <backend>`.
 *
 * One renderer because four surfaces point at it — the `--seed` and `--table`
 * summaries, `release create`'s seed refusals and `workspace reset-tables` —
 * and each used to spell a per-noun verb of its own. When the verb moved, every
 * copy had to be found by hand; a caller of this cannot point at a verb that
 * does not exist.
 */
export function tablesCommand(backend = "<backend>"): string {
  return `xanosdk tables ${backend}`;
}

/**
 * A shared flag as `deploy` lists it when the flag only scopes a `--to`
 * destination. Without `--to` a deploy refreshes its own ephemeral or local
 * engine and refuses these, so the help page says so rather than letting the
 * refusal be the first place a reader learns it.
 */
function withToOnly(key: FlagKey): FlagRef {
  return { key, summary: `${FLAGS[key].summary} — only with --to` };
}

/**
 * The mirror of {@link withToOnly}: a `deploy` flag that describes the
 * ephemeral a deploy without `--to` refreshes, and is refused under `--to`
 * (`EPHEMERAL_ONLY` in deploy-command.ts). The help line says so, so a reader
 * does not learn it from the refusal.
 */
function withoutTo(key: FlagKey, summary: string = FLAGS[key].summary): FlagRef {
  return { key, summary: `${summary} — not with --to` };
}

/**
 * Every command `xanosdk` accepts. Order within a group is the render order;
 * groups render in {@link HELP_GROUP_ORDER}.
 */
export const COMMANDS = {
  // ── Author ──────────────────────────────────────────────────────────────
  compile: {
    group: "Author",
    display: "compile <file>",
    // Says "single object def", not "workspace": this command takes ONE def and
    // prints its JSON artifact. `compile` is the first command listed under
    // Author, so it is the first thing tried on the scaffold entry (a
    // workspace), which fails — the summary must not promise otherwise.
    // `export` is the workspace command. It does not type-check: the entry is
    // loaded with its types stripped, so `tsc` is what catches a type error.
    summary: "Compile a single object def and print its JSON artifact (not type-checked — run `tsc` for that)",
    args: [{ name: "file", required: true, path: true }],
    flags: ["out", "lock", "strict", "export"],
    example: "xanosdk compile ./xano/query/public/health_GET.ts",
  },
  export: {
    group: "Author",
    display: "export <file>",
    summary: "Compile and write the deployable JSON bundle",
    args: [{ name: "file", required: true, path: true }],
    flags: [
      "out",
      ...COMPILE,
      {
        key: "check",
        summary:
          "CI check: run every export check and fail instead of changing the lock, writing nothing — no bundle, no lock, so no secrets are needed",
      },
    ],
    example: "xanosdk export ./index.ts --out bundle.json",
  },
  routes: {
    group: "Author",
    display: "routes <file>",
    summary: "List each query's verb + resolved api:<canonical>/<name>",
    args: [{ name: "file", required: true, path: true }],
    flags: [
      "lock",
      "emit",
      {
        key: "strict",
        summary:
          "With --emit: write nothing, and fail when the file is missing or out of date (what xano:check runs)",
      },
    ],
    example: "xanosdk routes ./index.ts --emit xano/routes.gen.ts",
  },
  // `routes` is the canonical spelling: it is the word every web framework uses
  // for this list, where `paths` is OpenAPI's term for the same thing and reads
  // as filesystem paths to everyone else. `paths` still dispatches — it is what
  // the command was called — but it is off the menu.
  paths: {
    group: "Author",
    display: "paths <file>",
    summary: "Alias for `routes`",
    aliasOf: "routes",
    args: [{ name: "file", required: true, path: true }],
    flags: [
      "lock",
      "emit",
      {
        key: "strict",
        summary:
          "With --emit: write nothing, and fail when the file is missing or out of date (what xano:check runs)",
      },
    ],
  },
  init: {
    group: "Author",
    display: "init [dir]",
    // Toolchain modules contribute their own question flags; see the field's
    // doc for the obligation this takes on.
    deferUnknownFlags: true,
    summary: "Scaffold a Xano SDK project — empty, or filled from an existing backend",
    args: [{ name: "dir", required: false, path: true }],
    // Two axes on top of the shared scaffold flags: WHERE `xano/` comes from
    // (`--from`) and HOW the options were collected (`--web`). They compose —
    // a browser-chosen shell around a decoded workspace is one invocation.
    //
    // `--marketplace` rides with them but is not in SCAFFOLD: a `--from` run
    // writes a project around a workspace that already exists, and adding
    // add-ons to one is `marketplace install`, not a scaffold decision.
    //
    // `--report`, `--skip-roundtrip` and the auth flags only bite under `--from`;
    // passing them without it is a usage error rather than a silent no-op.
    flags: [
      ...SCAFFOLD,
      "marketplace",
      {
        key: "from",
        summary: "Fill xano/ by decoding an existing backend instead of writing the empty starter",
        selector: { accepted: [...BACKEND, "release", "file"], role: "from", default: "none" },
      },
      "web",
      "skip-roundtrip",
      "report",
      "no-secrets",
      {
        key: "yes",
        summary:
          "Confirm without asking what --force overwrites, or what --from replaces in an existing xano/ — required when there is no terminal",
      },
      {
        key: "branch",
        summary: "Read this branch instead of the live one (`--from workspace` only)",
      },
      ...AUTH,
    ],
    // One flag from each axis the command now has — look, add-ons —
    // rather than every flag it accepts.
    example: "xanosdk init my-app --theme zinc-blue --marketplace @xano-sdk/auth",
  },
  marketplace: {
    group: "Author",
    // Every verb, spelled out. The family is a lifecycle — find it, add it,
    // change it, drop it — and a row that stopped at `install` read as though
    // the last two did not exist. `tenant` already carries six the same way.
    display: "marketplace <list|search|details|install|reinstall|remove>",
    summary: "Find Xano SDK add-on packages and add them to this project",
    subcommands: {
      // No apostrophes in any registry string: zsh completion single-quotes
      // these, and the completion suite fails the whole script on an odd quote.
      list: {
        summary: "List every published add-on, newest first",
        extraArgHint: "`list` prints the whole catalogue; `xanosdk marketplace search <query>` is the filter.",
        example: "xanosdk marketplace list",
      },
      search: {
        summary: "Search add-ons by keyword across name, tagline and description",
        // Variadic: the handler joins every term into one phrase query, so
        // `search ai agent` searches for "ai agent" rather than dropping "agent".
        args: [{ name: "query", required: true, variadic: true }],
        example: "xanosdk marketplace search auth",
      },
      details: {
        summary: "Show what an add-on installs, what it needs, and how to register it",
        args: [{ name: "package", required: true }],
        flags: ["prompt"],
        example: "xanosdk marketplace details @xano-sdk/auth",
      },
      install: {
        summary:
          "Install a marketplace module into the Xano SDK project in the current directory, by package or catalogue name (auth resolves to @xano-sdk/auth); a name the marketplace does not list exits 8",
        args: [{ name: "package", required: true }],
        // An installed toolchain module contributes questions, each deriving a
        // flag that answers it non-interactively — and which modules exist is
        // not knowable until npm has run, long after parsing. Declared on the
        // VERB, never on `marketplace`: see SubcommandSpec.deferUnknownFlags.
        deferUnknownFlags: true,
        example: "xanosdk marketplace install @xano-sdk/auth",
      },
      reinstall: {
        summary: "Re-ask the questions for an installed toolchain module and re-apply its settings (takes the names install takes)",
        args: [{ name: "package", required: true }],
        // Same reason as `install`: this verb runs the questionnaire, so the
        // flags a module derives from its own questions cannot be known until
        // the module has been imported.
        deferUnknownFlags: true,
        example: "xanosdk marketplace reinstall <toolchain-package>",
      },
      remove: {
        summary: "Uninstall a Xano SDK module and drop the settings and file lines it contributed (takes the names install takes)",
        args: [{ name: "package", required: true }],
        // Deliberately NO deferUnknownFlags: this verb runs no
        // questionnaire, so nothing downstream could ever claim a plugin flag.
        // Deferring here would accept `--renderer-dir=x` on a removal and
        // silently discard it.
        example: "xanosdk marketplace remove <toolchain-package>",
      },
    },
  },

  // ── Deploy ──────────────────────────────────────────────────────────────
  deploy: {
    group: "Deploy",
    display: "deploy [source]",
    summary: "Deploy to the Xano Engine on this machine (default) or an ephemeral (--ephemeral) → URL",
    // Optional: a bare `deploy` inside a project compiles its entry, and the
    // argument may name a backend to take the bytes FROM instead of a path.
    args: [
      {
        name: "source",
        required: false,
        path: true,
        satisfiedBy: ["bundle"],
        selector: { accepted: ["release", ...BACKEND, "file"], role: "subject", default: "entry" },
      },
    ],
    flags: [
      withoutTo("expires-hours"),
      withoutTo(
        "name",
        "Display name for the ephemeral env (default for a new one: the release name for release:<name>, else the workspace name, else this directory's)",
      ),
      {
        key: "to",
        summary:
          "Merge into a real destination instead of replacing the Xano Engine or an ephemeral. The escape hatch from the release flow",
        // An ephemeral and a Xano Engine are where a deploy goes WITHOUT
        // `--to`; naming one here is the other path spelled wrong, and the
        // reason says which flag that path is.
        selector: {
          accepted: ["workspace", "tenant"],
          role: "to",
          default: "none",
          refused: {
            "local": "a deploy to a Xano Engine is `--local`, which also downloads, pins and starts one",
            ephemeral:
              "`--ephemeral` already replaces an ephemeral. To merge into one instead, name it as the " +
              "tenant it is: `--to tenant:<ephemeral name>`",
          },
        },
      },
      "local",
      "ephemeral",
      withToOnly("dry-run"),
      withToOnly("prune"),
      withToOnly("reset-data"),
      withToOnly("seed"),
      withToOnly("replace"),
      withToOnly("allow-shared-schema-changes"),
      withToOnly("allow-branch-deletion"),
      withToOnly("branch"),
      withToOnly("set-live"),
      withToOnly("backup-branch"),
      "yes",
      "bundle",
      "static",
      { key: "static-host", summary: "With --static: static-host name to deploy to (default: default)" },
      { key: "static-routing", summary: "With --static: override URL resolution (inferred from the bundle; rarely needed)" },
      {
        key: "static-env",
        summary: "With --static: public config baked in as window.<KEY> (repeatable; never secrets)",
      },
      withoutTo("no-dev-env"),
      "skip-liveness",
      withoutTo("require-microservices"),
      withoutTo("test"),
      withoutTo("kind", "With --test: only this test family (default: both)"),
      withoutTo("concurrency", "With --test: run this many tests at once (default: 1)"),
      withoutTo("open"),
      "keep-data",
      withoutTo("reset"),
      ...COMPILE,
      ...AUTH,
    ],
    example: "xanosdk deploy ./index.ts --test",
  },
  env: {
    group: "Deploy",
    display: "env <pull|set|unset>",
    summary:
      "The backend env VALUES in .env beside the backend (xano/.env by default) — one of the two files there that are not committed — and one value at a time on a running backend",
    subcommands: {
      pull: {
        // Self-contained: the scoped help page renders this line ALONE, without
        // the `env` summary above it that says which file "that" is.
        summary:
          "Fill the local .env from a backend that is running. Over an existing file it lists what changes and confirms, then rewrites the whole file; a missing file is created without asking, and identical values write nothing",
        flags: [
          {
            key: "from",
            summary: "Read the values from this backend instead of the one this project last deployed to",
            selector: { accepted: BACKEND, role: "from", default: "tracked" },
          },
          {
            key: "yes",
            summary: "Skip the confirmation before an existing .env is changed (required for that when there is no terminal)",
          },
          "backend-dir",
          ...AUTH,
        ],
        example: "xanosdk env pull --from workspace",
      },
      set: {
        summary:
          "Set ONE env var on a running backend by name — creates it or replaces its value, leaves every other one alone. The value is the second argument, or stdin when omitted; it is never printed",
        args: [
          { name: "name", required: true },
          { name: "value", required: false },
        ],
        flags: [
          ...ENV_VAR_TARGET_FLAGS,
          {
            key: "allow-empty-env",
            spec: "--allow-empty-env=NAME",
            summary:
              "Store an EMPTY value for NAME. Refused without it: an empty value is usually an unset shell variable. To remove the variable, use `env unset`",
          },
          ...AUTH,
        ],
        example: "printf %s \"$STRIPE_KEY\" | xanosdk env set STRIPE_KEY --to workspace --yes",
      },
      unset: {
        summary:
          "Clear ONE env var on a running backend by name, leaving every other one alone. A name it does not have is reported, not an error",
        args: [{ name: "name", required: true }],
        flags: [...ENV_VAR_TARGET_FLAGS, ...AUTH],
        example: "xanosdk env unset STRIPE_KEY --to workspace --yes",
      },
    },
  },
  secrets: {
    group: "Deploy",
    // One verb today, and the noun is still the right shape: the file this
    // family owns is the project's secret STORE, and `xanosdk fill` would say
    // nothing about what is being filled.
    display: "secrets <fill>",
    summary:
      "The documentation tokens in .secrets.json beside the backend (xano/.secrets.json by default) — the other file there that is not committed",
    subcommands: {
      fill: {
        summary: "Mint a token for every documentation gate that has none (never replaces one)",
        args: [{ name: "file", required: false, path: true }],
        flags: ["lock"],
        example: "xanosdk secrets fill",
      },
    },
  },
  release: {
    group: "Deploy",
    display: "release <create|list|show|export|delete|transfer>",
    summary: "Cut and manage releases — the stored record of a backend that ran",
    subcommands: {
      create: {
        summary: "Cut a release from a running environment, tenant, or the workspace",
        args: [{ name: "name", required: true }],
        flags: [
          // A release is cut from something that RAN, so a path is not in the
          // set, and the cut runs on the instance, so a Xano Engine is refused
          // with that reason rather than left unknown.
          {
            key: "from",
            summary:
              "Cut from this backend instead of the one this project last deployed to (a tenant only when it is a throwaway one: ephemeral or sandbox)",
            selector: {
              accepted: CUT,
              role: "from",
              default: "tracked",
              refused: {
                "local": "the cut runs on the instance, which cannot reach an engine on this machine",
              },
            },
          },
          "description",
          // Only meaningful with `--from workspace`: it names which branch to
          // package. An environment has one, so it takes no label.
          { key: "branch", summary: "Cut from this branch of your workspace (default: the one it serves)" },
          // Deploy's own summary describes writing a BUNDLE's rows into a
          // target. This is the opposite direction — it captures the source's
          // current rows into the archive — so the shared summary would be a
          // category error here.
          // The re-mint caveat's second surface: the refusal catches a
          // stale guid, but only after one has been written down. This states it
          // before anything is run.
          {
            key: "seed",
            spec: "--seed[=<guids>]",
            summary:
              "Carry the source's table ROWS in the archive: every table, or only these guids " +
              `(\`${tablesCommand()}\` lists them for the backend you are cutting from). ` +
              `${GUID_STABILITY_NOTE}. Off by default — schema always travels either way`,
          },
          { key: "yes", summary: "Skip the confirmation when seeded rows include non-public columns" },
          // The comparison's input, and the only reason a bundle path appears on
          // a command that cannot be cut FROM one. Advertised because it was
          // always accepted — the parser takes `--bundle` for every command —
          // and an accepted flag missing from the page is how the comparison
          // came to be documented by rows that named it and a page that did not.
          {
            key: "bundle",
            summary:
              "Compare the source against this already-exported bundle instead of compiling " +
              "the project's entry. The release still carries what is RUNNING",
          },
          {
            key: "entry",
            summary:
              "Compare the source against a compile of this entry instead of the project's default one " +
              "(a nested backend, `--entry=suites/alpha/xano/index.ts`). The release still carries what is RUNNING",
          },
          ...COMPILE_COMPARISON_ONLY,
          ...AUTH,
        ],
        example: "xanosdk release create v2 --seed=386c35157cc010fb685bdf967258b502",
      },
      list: {
        summary: "Every release in this workspace",
        flags: [...AUTH],
      },
      show: {
        summary: "One release: where it came from, and what it carries",
        args: [{ name: "name", required: true }],
        flags: [...AUTH],
      },
      export: {
        summary: "Write a release out as XanoScript (its `workspace` block is named after the release)",
        args: [{ name: "name", required: true }],
        flags: ["path", ...AUTH],
      },
      delete: {
        summary: "Remove a release. Anything running it keeps running",
        args: [{ name: "name", required: true }],
        flags: ["yes", ...AUTH],
      },
      transfer: {
        summary: "Copy a stored release to another workspace or instance, checked by content hash",
        args: [{ name: "name", required: true }],
        flags: [
          "to-profile",
          {
            key: "dry-run",
            summary: "Report whether the release is already at the destination, and write nothing",
          },
          { key: "yes", summary: "Skip the confirmation (the seeded-table listing still prints)" },
          ...AUTH,
        ],
        example: "xanosdk release transfer v2 --to-profile prod",
      },
    },
    example: "xanosdk release create v2",
  },
  pull: {
    group: "Author",
    display: "pull [source]",
    summary:
      "Refresh the backend of this project from a live one — rewrites the files it decodes, keeps and names files you added, and lists and confirms first",
    args: [
      {
        name: "source",
        required: false,
        selector: { accepted: [...BACKEND, "release"], role: "subject", default: "tracked" },
      },
    ],
    // `--yes`, as `env pull` spells the same act: everything it waives is one
    // meaning — replace local state anyway — and the registry holds each
    // command to one flag per meaning. The confirmation, uncommitted changes
    // and a lock that shares no identity with the source are all the same
    // answer to the same question.
    flags: [
      {
        key: "yes",
        summary:
          "Rewrite without asking (required when there is no terminal), over uncommitted changes and a lock that shares no identity with the source too — files you added are still kept",
      },
      "no-secrets",
      // The shared summary says "act on"; for `pull` the act is a refresh, and
      // a flag page that does not say what it rewrites is describing a different command.
      {
        key: "backend-dir",
        summary:
          "The backend directory to refresh (its decoded files are rewritten, files you added are kept), when this project does not keep it in xano/ and nothing on disk says so",
      },
      "skip-roundtrip",
      { key: "branch", summary: "Read this branch of the workspace instead of the live one (`workspace` only)" },
      ...AUTH,
    ],
    example: "xanosdk pull release:main",
  },
  generate: {
    group: "Author",
    display: "generate <source>",
    summary: "Decode a backend or a bundle .json into a Xano SDK source tree, with no project around it",
    args: [
      {
        name: "source",
        required: true,
        path: true,
        selector: { accepted: [...BACKEND, "release", "file"], role: "subject", default: "none" },
      },
    ],
    flags: [
      { key: "out", spec: "--out, -o <dir>", summary: "Directory to write the tree into (default: ./xano)" },
      {
        key: "force",
        summary:
          "Replace a backend tree a decode wrote in --out (keeps .env and .secrets.json; reconciles xano.lock against the source)",
      },
      {
        key: "yes",
        summary:
          "With --force, replace files you edited since the last decode without asking (required when there is no terminal)",
      },
      { key: "branch", summary: "Read this branch of the workspace instead of the live one (`workspace` only)" },
      "no-secrets",
      ...AUTH,
    ],
    example: "xanosdk generate release:v1 --out ./xano",
  },
  promote: {
    group: "Deploy",
    display: "promote <release>",
    summary: "Land a release in your real workspace",
    args: [{ name: "release", required: true }],
    // A promote NEVER lands on live, so the shared `--branch` summary ("instead
    // of the live one") describes the wrong thing here: the flag names the
    // branch, it does not divert from live. Absent, a label is derived — the
    // engine's own default is an empty one, which nothing can address.
    flags: [
      {
        key: "branch",
        summary: "Land on this branch (default: derived from the release name; never live)",
      },
      "set-live",
      "expect-live",
      {
        key: "allow-shared-schema-changes",
        summary: "Land a release that alters tables live serves from (tables are shared by every branch)",
      },
      "yes",
      {
        key: "entry",
        summary:
          "Record the landing in this nested backend's xano.lock, from a directory that is no project",
      },
      ...AUTH,
    ],
    example: "xanosdk promote main",
  },
  publish: {
    group: "Deploy",
    display: "publish <dir>",
    summary: "Publish an already-built frontend to a static host — no compile, no backend import",
    args: [{ name: "dir", required: true, path: true }],
    // The destination's own base URL is injected as `window.XANO_HOST`, so the
    // SAME build published to two destinations serves two different documents.
    flags: [
      {
        key: "to",
        summary: "Where to publish, instead of the backend this project last deployed to",
        selector: {
          accepted: BACKEND,
          role: "to",
          default: "tracked",
        },
      },
      "release",
      {
        key: "branch",
        summary:
          "Refuse unless this branch is live on your workspace — the check that the frontend lands in front of the backend it was built for (--to workspace only)",
      },
      "static-env",
      "static-host",
      "static-routing",
      "skip-liveness",
      { key: "yes", summary: "Skip the confirmation before replacing a workspace's or tenant's frontend" },
      ...AUTH,
    ],
    example: "xanosdk publish ./frontend/dist --to workspace --release v2 --branch v2-20260922T120000Z",
  },
  tenant: {
    group: "Environments",
    display: "tenant <list|get|deploy|delete>",
    summary: "Your real tenants — list, inspect, and land a release on one",
    subcommands: {
      list: { summary: "Every tenant under this workspace", flags: [...AUTH] },
      get: {
        summary: "The URL and state of one tenant",
        args: [{ name: "name", required: true }],
        flags: [...AUTH],
      },
      deploy: {
        summary: "Replace what a tenant serves with a release",
        args: [
          { name: "name", required: true },
          { name: "release", required: true },
        ],
        flags: ["yes", ...AUTH],
        example: "xanosdk tenant deploy acme v2",
      },
      delete: {
        summary: "Destroy a tenant and everything it serves",
        args: [{ name: "name", required: true }],
        flags: [
          "yes",
          {
            key: "lock",
            summary:
              "The xano.lock whose landing record for it is cleared — default: the project's. A name that is not there any more clears a stale record too",
          },
          ...AUTH,
        ],
      },
    },
    example: "xanosdk tenant deploy acme v2",
  },
  preflight: {
    group: "Deploy",
    display: "preflight <file>",
    // Says "deploy" in the summary because the name has to keep signalling the
    // cost: this authenticates, creates a throwaway environment, and imports
    // into it. `validate` read as a local type-check, which is what people
    // reached for first and what this is not.
    summary: "Deploy to a throwaway tenant and verify the round-trip (needs auth)",
    args: [{ name: "file", required: true, path: true, satisfiedBy: ["bundle"] }],
    // `...AUTH` is what makes the "(needs auth)" above true for a user who has
    // only ever run `xanosdk login`: it declares the credential flags, and
    // `isAuthenticatedCommand` derives from that declaration — so registering
    // it here is also what gets `--profile` honoured rather than refused.
    // `--instance` remains the maintainer override and wins over all of it.
    flags: [
      "bundle",
      "runtime",
      "capture",
      "verbose",
      "instance",
      { key: "out", spec: "--out, -o <dir>", summary: "With --capture: the directory the fixtures land in (default: validate-out)" },
      ...COMPILE,
      ...AUTH,
    ],
    example: "xanosdk preflight ./index.ts --runtime",
  },


  // ── Environments ────────────────────────────────────────────────────────
  workspace: {
    group: "Environments",
    display: "workspace",
    summary: "Your real workspace — details, export, diff, table resets, and branches",
    subcommands: {
      details: {
        summary: "Which instance and workspace am I bound to?",
        flags: [...AUTH],
        example: "xanosdk workspace details",
      },
      export: {
        summary: "Write its bundle JSON",
        flags: [
          "path",
          { key: "name", summary: "Output basename (default: `workspace`)" },
          { key: "branch", summary: "Export this branch instead of the live one" },
          ...AUTH,
        ],
        example: "xanosdk workspace export --branch staging --path -",
      },
      diff: {
        // Named for the question, not the mechanism: "did my release land" is
        // what a staged branch cannot otherwise answer. The release reports what
        // it SENT; this reports what is there.
        summary: "Compare it (or one of its branches) against a local compile — which objects differ, are missing, or are unexpected. Exits 2 when anything declared differs or is missing",
        args: [{ name: "file", required: true, path: true, satisfiedBy: ["bundle"] }],
        flags: [
          "bundle",
          { key: "branch", summary: "Compare this branch instead of the live one" },
          ...COMPILE,
          ...AUTH,
        ],
        example: "xanosdk workspace diff ./index.ts --branch staging",
      },
      "reset-tables": {
        // Named for what it does to the DATA, not for the two calls it makes.
        // "reset" is the promise: afterwards the table holds what the project
        // says it holds, no more and no less.
        summary:
          "Put named tables back to the seed rows your project compiles — every other table is left alone",
        // No `--bundle`: an exported bundle carries no seed rows, so there is
        // nothing in one to reset to. Undeclaring it also keeps a `.json`
        // positional from being read as one — the command refuses it by name.
        args: [{ name: "file", required: true, path: true }],
        flags: ["table", "write", "yes", ...COMPILE, ...AUTH],
        example: "xanosdk workspace reset-tables ./index.ts --table <guid> --write",
      },
      branch: {
        summary: "List its branches, set one live, or delete one",
        display: "workspace branch <list|set-live|delete> [label]",
        args: [
          // The closed set, so `--help` lists the verbs (and completion offers them).
          { name: "verb", required: true, values: ["list", "set-live", "delete"] },
          { name: "label", required: false },
        ],
        flags: [
          "yes",
          {
            key: "expect-live",
            summary: "With set-live: refuse unless <label> is live — checked before asking and again before switching (not atomic)",
          },
          ...AUTH,
        ],
        example: "xanosdk workspace branch list",
      },
    },
  },
  ephemeral: {
    group: "Environments",
    display: "ephemeral",
    summary: "Manage ephemeral envs — list, get, delete, export",
    subcommands: {
      list: {
        summary: "List the ephemeral envs under your workspace",
        flags: ["all-workspaces", ...AUTH],
        example: "xanosdk ephemeral list",
      },
      get: {
        summary: "Show one env's URL, status, and expiry",
        args: [{ name: "name", required: true }],
        flags: [...AUTH],
      },
      delete: {
        summary: "Tear an env down now instead of waiting for its TTL",
        args: [{ name: "name", required: true }],
        flags: ["yes", ...AUTH],
      },
      export: {
        summary: "Write an env's bundle JSON (default: the ephemeral this project deployed to)",
        args: [{ name: "name", required: false }],
        flags: ["format", "path", { key: "name", summary: "Output basename (default: the env name)" }, ...AUTH],
      },
    },
  },
  "local": {
    group: "Environments",
    display: "local",
    // The handles that ship with `deploy --local`: a Xano Engine has no
    // TTL and nothing reclaims it, and its binary is never on `PATH`, so these
    // verbs are the only way to see or stop one (`impersonate local`
    // opens one, like any other backend).
    summary:
      "See, authenticate against and stop Xano Engines on this machine; move the " +
      "project's engine pin and manage cached engine versions",
    subcommands: {
      list: {
        summary: "List Xano Engines on this machine, marking the ones xanosdk started",
        example: "xanosdk local list",
      },
      token: {
        // The engine's meta API accepts only its own bearer, and no summary
        // carries it — so this verb is the only way a suite gets one. Bare on
        // stdout even when piped, because `$(…)` is the form it exists for.
        summary:
          "Print a Xano Engine's meta API bearer — the local XANO_META_TOKEN; `--json` adds its url " +
          "and workspace id. Re-run after a restart, which re-mints it " +
          "(default: the engine this project deployed to)",
        args: [{ name: "name", required: false }],
        example: "XANO_META_TOKEN=$(xanosdk local token)",
      },
      stop: {
        // The name is optional because `--all` stands in for it — and `--all`
        // is the form most runs want, since it covers every project.
        summary: "Stop one Xano Engine by name, or every one xanosdk started on this machine",
        args: [{ name: "name", required: true, satisfiedBy: ["all"] }],
        flags: [
          {
            key: "all",
            summary: "Every engine xanosdk started on this machine, across projects (foreign ones are reported, not stopped)",
          },
        ],
        example: "xanosdk local stop --all",
      },
      update: {
        // Running it IS the confirmation, so it never prompts — the deploy only
        // offers a newer engine; this is the verb that takes it.
        summary:
          "Move this project's pinned engine to the latest release (or `--version <v>`, downgrades " +
          "included), download it, and restart the project's running engine on it — the restarted " +
          "engine starts empty, so the next deploy seeds it. Writes package.json: commit it",
        flags: [
          {
            key: "engine-version",
            summary: "Pin this engine version instead of the latest, like v0.1.5 — or `latest`, the default",
          },
        ],
        example: "xanosdk local update",
      },
      cache: {
        // One verb with an action argument, not two top-level verbs: both act on
        // the same cached binaries under the engine cache.
        summary:
          "`list`: each cached engine version, its size on disk, and the engines running on it. " +
          "`clear`: remove every cached engine and the runtime they unpacked, or one with `--version <v>` — any engine running " +
          "on a removed version is stopped first; the next deploy fetches and restarts it",
        args: [{ name: "action", required: true, values: ["list", "clear"] }],
        flags: [
          {
            key: "engine-version",
            summary: "`clear` only: remove just this cached version — v0.1.5, `latest` (the release `update` would pin), `override`, or an override's `src-…` id from `cache list`",
          },
          {
            key: "legacy-runtime",
            summary: "`clear` only: remove instead the runtime copy earlier versions unpacked in your own cache directory (`cache list` shows it); asks first",
          },
          { key: "yes", summary: "Skip the `--legacy-runtime` confirmation (required when there is no terminal)" },
        ],
        example: "xanosdk local cache clear --version v0.1.5",
      },
    },
  },
  test: {
    group: "Environments",
    display: "test",
    summary: "Run the unit and workflow tests an environment carries",
    subcommands: {
      list: {
        summary: "List the tests in an environment, without running any",
        flags: [TEST_LIST_ON, "kind", ...AUTH],
        example: "xanosdk test list --on workspace",
      },
      run: {
        summary: "Run one test by name",
        args: [{ name: "name", required: true }],
        flags: [TEST_ON, ...AUTH],
        example: "xanosdk test run \"happy path\" --on workspace",
      },
      "run-all": {
        summary: "Run every test in an environment and report pass/fail",
        flags: [TEST_ON, "kind", "concurrency", ...AUTH],
        example: "xanosdk test run-all --on ephemeral:pr-3",
      },
    },
  },
  tables: {
    group: "Environments",
    display: "tables [backend]",
    // How the guids `release create --seed` takes are obtained at all: they
    // appear in no artifact a user holds, and names cannot substitute (see
    // `TableSummary.name`). One verb for every running backend rather than a
    // copy under each noun, so bare follows what the project last deployed to.
    // The caveat rides in the SUMMARY rather than in the output: a line printed
    // on every run becomes furniture, and `--json` is a data channel.
    summary:
      "List a backend's tables with their guids, for `release create --seed` " +
      `(default: the backend this project last deployed to). ${GUID_STABILITY_NOTE}`,
    args: [
      {
        name: "backend",
        required: false,
        selector: {
          accepted: BACKEND,
          role: "subject",
          default: "tracked",
          refused: {
            release: "a release is not a running backend — list the backend it was cut from, or land it and list that",
          },
        },
      },
    ],
    flags: [...AUTH],
    example: "xanosdk tables ephemeral:pr-3",
  },
  impersonate: {
    group: "Environments",
    display: "impersonate [backend]",
    // One verb for every backend a session can be minted for, so every kind
    // prints one JSON shape and bare opens what the project last deployed to.
    // The workspace is refused: it opens from the Xano dashboard as whoever is
    // signed in, so there is no session to mint.
    summary:
      "Open a backend's dashboard in the builder as a scoped session — the url carries it, so treat " +
      "it as a credential (default: the backend this project last deployed to)",
    args: [
      {
        name: "backend",
        required: false,
        selector: {
          accepted: ["ephemeral", "local", "tenant"],
          role: "subject",
          default: "tracked",
          refused: {
            workspace:
              "your workspace opens from the Xano dashboard as whoever is signed in, so there is no session to mint",
            release: "a release is not a running backend — land it with `xanosdk deploy release:<name>` and open that",
          },
        },
      },
    ],
    flags: [
      { key: "guest", summary: "Mint a read-only guest session (browse only)" },
      "url-only",
      ...AUTH,
    ],
    example: "xanosdk impersonate --guest",
  },

  // ── Account ─────────────────────────────────────────────────────────────
  login: {
    group: "Account",
    display: "login",
    summary: "OAuth sign-in — shared cache, or --local-auth per project",
    flags: [
      "local-auth",
      "paste",
      "port",
      "scope",
      "origin",
      "config",
      { key: "force", summary: "Overwrite the cached credential — sign in again even when one is already there" },
    ],
    example: "xanosdk login --local-auth",
  },
  logout: {
    group: "Account",
    display: "logout",
    summary: "Revoke the active profile and remove it from the credential file",
    flags: ["all", "yes", "local-auth", "config"],
    example: "xanosdk logout --profile staging",
  },
  status: {
    group: "Account",
    display: "status",
    summary: "Who am I, which workspace, and the env this project last deployed to",
    flags: [...AUTH],
    // Where a profile that is not stored is said: a typed one is a refusal, a
    // pinned one is state the report carries (E2E pass 21 — documented, not changed).
    notes:
      "A typed --profile that is not stored exits 8; one this project pins (xano.profile.json, $XANO_PROFILE) is reported as not signed in, exit 0.",
    example: "xanosdk status --json  # → { signedIn, signIn, instance, profile, user, workspace, environment }",
  },
  whoami: {
    group: "Account",
    display: "whoami",
    summary: "Show the signed-in user and instance URL",
    flags: [...AUTH],
    example: "xanosdk whoami",
  },
  // `whoami` is the canonical spelling for the QUESTION — it is the word every
  // other CLI answers it under. `profile` is the noun that owns the stored
  // credentials themselves, and its verbs manage them.
  profile: {
    group: "Account",
    display: "profile <verb>",
    summary: "Manage stored credential profiles",
    subcommands: {
      list: {
        summary: "Every stored profile, with the default and the active one marked",
        flags: [...CREDENTIAL_FILE],
        example: "xanosdk profile list",
      },
      show: {
        summary: "What one profile addresses — never its token (default: the active one)",
        args: [{ name: "name", required: false }],
        flags: [...CREDENTIAL_FILE],
        example: "xanosdk profile show staging",
      },
      // `use` and `set-default` differ only in SCOPE and sit one keystroke
      // apart, so each summary says which — the output does too.
      use: {
        summary: "Pin THIS PROJECT to a profile, in a committed xano.profile.json",
        args: [{ name: "name", required: true }],
        flags: [...CREDENTIAL_FILE],
        example: "xanosdk profile use staging",
      },
      "set-default": {
        summary: "Set the profile THIS MACHINE falls back to when nothing else selects one",
        args: [{ name: "name", required: true }],
        flags: [...CREDENTIAL_FILE],
        example: "xanosdk profile set-default prod",
      },
      add: {
        summary: "Store a meta API token credential under a name — the token is read from piped stdin or the terminal, and checked against the instance",
        args: [{ name: "name", required: true }],
        flags: [
          { key: "instance", summary: "Instance URL the meta API token addresses" },
          "workspace-id",
          { key: "force", summary: "Replace a profile that already exists under this name" },
          ...CREDENTIAL_FILE,
        ],
        example: "xanosdk profile add ci --instance https://x8ki.xano.io --workspace-id 7",
      },
      delete: {
        summary: "Remove a profile, revoking its sign-in session — a meta API token stays valid until revoked at its source",
        args: [{ name: "name", required: true }],
        flags: ["yes", ...CREDENTIAL_FILE],
        example: "xanosdk profile delete staging --yes",
      },
    },
  },

  // ── Maintenance ─────────────────────────────────────────────────────────
  lock: {
    group: "Maintenance",
    display: "lock",
    summary: "Maintain xano.lock identities — rename, prune, import",
    subcommands: {
      rename: {
        summary: "Move an entry keeping its identity, so the next export renames in place",
        args: [
          { name: "kind", required: true },
          { name: "old", required: true },
          { name: "new", required: true },
        ],
        flags: [
          { key: "lock", summary: "Name the xano.lock to edit — default: beside --entry or the project entry" },
          "entry",
        ],
        example: "xanosdk lock rename --entry=xano/index.ts table users members",
      },
      prune: {
        summary: "Drop orphaned entries (all, or just the named keys)",
        args: [
          // `--entry=<path>` names the same file; with it, every positional is a key.
          { name: "entry-file", required: true, path: true, satisfiedBy: ["identity-only", "entry"] },
          { name: "keys…", required: false, variadic: true },
        ],
        flags: [
          "yes",
          "lock",
          { key: "entry", summary: "The entry file as a flag, in place of <entry-file> — every positional is then a key" },
          {
            key: "identity-only",
            summary: "Prune the named keys without loading the entry file",
          },
        ],
        example: "xanosdk lock prune ./index.ts --yes",
      },
      // `import`, not `adopt`: the verb names where the identities COME FROM,
      // which is the only thing a reader needs in order to know whether this is
      // the command they want. "Adopt" described the internal effect and left
      // the input — a live export — entirely unstated.
      import: {
        summary:
          "Import identities from a live backend's exported bundle (`xanosdk workspace export`), so existing objects are not recreated",
        args: [{ name: "bundle.json", required: true, path: true }],
        flags: [
          "yes",
          { key: "lock", summary: "Name the xano.lock to write — default: beside --entry or the project entry" },
          "entry",
        ],
        example: "xanosdk lock import ./live.json --entry=xano/index.ts",
      },
    },
  },
  completion: {
    group: "Maintenance",
    display: "completion <shell>",
    summary: "Print a shell completion script (bash, zsh, fish)",
    args: [{ name: "shell", required: true, values: ["bash", "zsh", "fish"] }],
    example: "xanosdk completion zsh > \"${fpath[1]}/_xanosdk\"",
  },
  version: {
    group: "Maintenance",
    display: "version",
    summary: "Print the CLI version",
  },
  upgrade: {
    group: "Maintenance",
    display: "upgrade",
    summary: "Install the latest @xano/sdk, or report an available upgrade with --check",
    flags: ["check"],
    example: "xanosdk upgrade --check",
  },
  help: {
    group: "Maintenance",
    display: "help",
    summary: "Show this help",
    // Variadic: a help target is a command PATH (`help workspace export`), and
    // `resolveHelpRequest` reads it from the raw argv before any arity check.
    args: [{ name: "command", required: false, variadic: true }],
    example: "xanosdk help deploy",
  },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMANDS;

/** Whether `name` is a command the CLI knows (including removed and alias entries). */
export function isCommand(name: string): name is CommandName {
  return Object.hasOwn(COMMANDS, name);
}

/** Look up a command spec, or undefined when the name is unknown. */
export function getCommand(name: string): CommandSpec | undefined {
  return isCommand(name) ? (COMMANDS[name] as CommandSpec) : undefined;
}

/** Whether a command (or its verb) declares the flag `key` — the registry's answer, not the parser's. */
export function acceptsFlag(command: string | undefined, subcommand: string | undefined, key: string): boolean {
  return flagRefFor(command, subcommand, key) !== undefined;
}

/** The command's (or verb's) own reference to a flag, carrying any per-command `values`. */
export function flagRefFor(command: string | undefined, subcommand: string | undefined, key: string): FlagRef | undefined {
  if (command === undefined) return undefined;
  const spec = subcommand === undefined ? getCommand(command) : getSubcommand(command, subcommand);
  return (spec?.flags ?? []).find((f) => flagKey(f) === key);
}

/** Look up a subcommand spec under a command, or undefined. */
export function getSubcommand(command: string, sub: string): SubcommandSpec | undefined {
  const subs = getCommand(command)?.subcommands;
  return subs && Object.hasOwn(subs, sub) ? subs[sub] : undefined;
}

/**
 * Command names offered in global help and in did-you-mean suggestions: the
 * live ones only, so a typo is never "corrected" to an alias that duplicates
 * its target.
 */
export function liveCommandNames(): string[] {
  return Object.entries(COMMANDS)
    .filter(([, spec]) => (spec as CommandSpec).aliasOf === undefined)
    .map(([name]) => name);
}

/**
 * Every flag name the CLI parses, whatever the command — what a toolchain
 * module's derived flag must not collide with. Did-you-mean does NOT read it:
 * the parser refuses a flag the command does not declare, so a suggestion is
 * drawn from the command's own flags and the global ones (`errors.ts`).
 */
export function flagNames(): string[] {
  return Object.keys(FLAGS);
}

/** The key a flag reference points at. */
export function flagKey(ref: FlagRef): string {
  return typeof ref === "string" ? ref : ref.key;
}

/** The spec to render for a flag reference — the command's override, else the shared one. */
export function flagSpec(ref: FlagRef): string {
  if (typeof ref !== "string" && ref.spec !== undefined) return ref.spec;
  return FLAGS[flagKey(ref) as FlagKey].spec;
}

/** The summary to render for a flag reference — the command's override, else the shared one. */
export function flagSummary(ref: FlagRef): string {
  if (typeof ref === "string") return FLAGS[ref as FlagKey].summary;
  // A selector slot's spellings are rendered from its declaration, never
  // written into the summary by hand.
  if (ref.selector !== undefined) return `${ref.summary}: ${sourceSpellings(ref.selector.accepted)}`;
  return ref.summary;
}

/**
 * The bare kinds a selector slot accepts, in the order a bare word is read —
 * what completion offers and the manifest publishes. A prefixed form
 * (`ephemeral:<name>`) needs its name glued on, which no menu can supply.
 */
export function selectorValues(selector: SelectorSpec): string[] {
  return SELECTOR_BARE.filter((k) => selector.accepted.includes(k));
}

/** The kinds that stand alone as a bare word (`BARE` in `source-selector.ts`; pinned by test). */
const SELECTOR_BARE = ["workspace", "ephemeral", "local"] as const satisfies readonly SourceKind[];

/** The closed set a positional accepts: its own `values`, else its selector's bare kinds. */
export function argValues(arg: ArgSpec): readonly string[] | undefined {
  if (arg.values !== undefined) return arg.values;
  return arg.selector !== undefined ? selectorValues(arg.selector) : undefined;
}

/**
 * The closed set a flag accepts IN THIS COMMAND — the command's override, else
 * the shared one, else undefined for a free-form flag. Help and shell
 * completion both read this rather than {@link FLAGS} directly, so a per-command
 * narrowing reaches every surface that shows the values.
 */
export function flagValues(ref: FlagRef): readonly string[] | undefined {
  if (typeof ref !== "string" && ref.values !== undefined) return ref.values;
  if (typeof ref !== "string" && ref.selector !== undefined) return selectorValues(ref.selector);
  // The `satisfies` on FLAGS keeps each entry's literal type, so only the
  // members that declare `values` have the property — widen to read it.
  return (FLAGS[flagKey(ref) as FlagKey] as FlagSpec | undefined)?.values;
}

/**
 * Whether {@link flagValues} is the flag's WHOLE set here. A selector slot is
 * open whenever it takes a named kind (`tenant:<name>`, `ephemeral:<name>`,
 * a path) — its bare kinds are only the words a menu can offer — and a shared
 * flag is open when it says so (`--theme`, `--radius`).
 */
export function flagValuesClosed(ref: FlagRef): boolean {
  if (typeof ref !== "string" && ref.values !== undefined) return true;
  if (typeof ref !== "string" && ref.selector !== undefined) return ref.selector.accepted.every((k) => k === "workspace");
  return (FLAGS[flagKey(ref) as FlagKey] as FlagSpec | undefined)?.open !== true;
}

/** A flag's values as `help --json` and the manifest publish them: `values` for a closed set, `examples` for an open one. */
export function publishedFlagValues(ref: FlagRef): { values: string[] } | { examples: string[] } | Record<string, never> {
  const values = flagValues(ref);
  if (values === undefined || values.length === 0) return {};
  return flagValuesClosed(ref) ? { values: [...values] } : { examples: [...values] };
}

/**
 * Subcommand names to SHOW under a command — {@link SubcommandSpec.unreleased}
 * ones excluded. The single choke point for
 * verb visibility: help's subcommand table, shell completion, and the
 * did-you-mean suggestion all read it, so a verb hidden here is hidden
 * everywhere. Dispatch does not consult it, which is what lets an unreleased
 * verb keep working for anyone who already knows its name.
 */
export function liveSubcommandNames(command: string): string[] {
  const subs = getCommand(command)?.subcommands;
  if (!subs) return [];
  return Object.entries(subs)
    .filter(([, spec]) => spec.unreleased === undefined)
    .map(([name]) => name);
}

/**
 * The flags to SHOW for a command or verb — everything it accepts, minus any
 * listed in {@link CommandSpec.unreleasedFlags}. Help and shell completion both
 * read this instead of `spec.flags`, so withholding a flag from one surface
 * withholds it from all of them. The parser reads `spec.flags` directly and is
 * unaffected.
 */
export function visibleFlags(spec: {
  flags?: readonly FlagRef[];
  unreleasedFlags?: readonly string[];
}): readonly FlagRef[] | undefined {
  const hidden = spec.unreleasedFlags;
  if (!spec.flags || !hidden || hidden.length === 0) return spec.flags;
  return spec.flags.filter((ref) => !hidden.includes(flagKey(ref)));
}

/**
 * How THIS command names its backend, for a refusal that points there — the
 * selector flags it declares (`--to`, `--from`), else a selector positional.
 * Empty when it takes none. Read from the table, so `env pull` is told `--from`
 * alone rather than a list of spellings only other commands take.
 */
export function selectorSpellings(command: string | undefined, subcommand: string | undefined): string[] {
  if (command === undefined) return [];
  const spec = subcommand === undefined ? getCommand(command) : getSubcommand(command, subcommand);
  const flags = (spec?.flags ?? [])
    .filter((f) => typeof f !== "string" && f.selector !== undefined)
    .map((f) => `\`--${flagKey(f)}\``);
  if (flags.length > 0) return flags;
  // Only without a selector flag: beside one (`deploy --to`), a selector
  // positional names what the command acts ON (`deploy <source>`), not where.
  const positional = (spec?.args ?? []).find((a) => a.selector !== undefined);
  return positional === undefined ? [] : [`its \`<${positional.name}>\` argument`];
}


/**
 * A flag as fields, for `help --json`: `--out, -o <path>` is
 * `{ name: "--out", short: "-o", arg: "<path>" }`, plus its closed set
 * (`values`) or a few of what an open one takes (`examples`), and its
 * description — so a reader never parses the spec string.
 */
export function structuredFlag(ref: FlagRef): {
  name: string;
  short?: string;
  arg?: string;
  values?: string[];
  examples?: string[];
  description: string;
} {
  const m = /^(--[a-z][a-z-]*)(?:, (-[a-z]))?(.*)$/.exec(flagSpec(ref));
  const name = m?.[1] ?? `--${flagKey(ref)}`;
  const arg = (m?.[3] ?? "").trim();
  return {
    name,
    ...(m?.[2] === undefined ? {} : { short: m[2] }),
    ...(arg === "" ? {} : { arg }),
    ...publishedFlagValues(ref),
    description: flagSummary(ref),
  };
}

/**
 * `help --json`: the same registry the text help renders, as one document —
 * every command (global), or one command's or verb's usage, flags and verbs.
 * Withheld (unreleased) verbs and flags are withheld here too.
 */
export function helpDocument(request: { command?: string; subcommand?: string }): Record<string, unknown> {
  const flags = (spec: { flags?: readonly FlagRef[]; unreleasedFlags?: readonly string[] }) =>
    (visibleFlags(spec) ?? []).map((ref) => ({ flag: flagSpec(ref), summary: flagSummary(ref), ...structuredFlag(ref) }));
  const spec = request.command === undefined ? undefined : getCommand(request.command);
  if (spec === undefined || request.command === undefined) {
    return {
      commands: liveCommandNames().map((name) => {
        const c = getCommand(name)!;
        return { name, usage: c.display, summary: c.summary, subcommands: liveSubcommandNames(name) };
      }),
    };
  }
  const sub = request.subcommand === undefined ? undefined : getSubcommand(request.command, request.subcommand);
  if (sub !== undefined) {
    return {
      command: request.command,
      subcommand: request.subcommand,
      summary: sub.summary,
      flags: flags(sub),
      ...(sub.example === undefined ? {} : { example: sub.example }),
    };
  }
  return {
    command: request.command,
    usage: spec.display,
    summary: spec.summary,
    flags: flags(spec),
    subcommands: liveSubcommandNames(request.command).map((name) => ({ name, summary: spec.subcommands![name]!.summary })),
    ...(spec.example === undefined ? {} : { example: spec.example }),
  };
}
