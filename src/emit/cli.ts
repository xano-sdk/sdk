/**
 * CLI:
 *   xanosdk compile <file> [--out <path>]   — emit one function's JSON
 *   xanosdk export  <file> [--out <path>]   — emit the aggregate workspace
 *                                            bundle from a default-exported
 *                                            `Xano` registry
 *   xanosdk lock <rename|prune|adopt> …     — xano.lock maintenance (see
 *                                            lock-commands.ts)
 *   xanosdk init [dir] [--from <source>]    — scaffold a project. `--from`
 *                                            decodes an existing backend into
 *                                            `xano/` instead of writing the
 *                                            starter (see codegen-command.ts):
 *                                            the pull half of the loop, whose
 *                                            push half is `deploy` — and that
 *                                            targets a DISPOSABLE env only.
 *
 * Dynamically imports the module's default export. A `.ts`/`.mts`/`.cts` entry
 * is loaded through `tsx` (the `tsImport` API) when it's installed, so you can
 * point the CLI straight at a TypeScript workspace file; plain `.js`/`.mjs`
 * goes through a normal dynamic `import`. See README.
 *
 * Identity locking: every command that compiles an entry file maintains a
 * `xano.lock` beside it — `export`, `deploy`, `release`, `preflight`, with no
 * flag. Each reads + validates the lock, seeds the guid override store BEFORE
 * the workspace module loads (references bake guids at authoring time — see
 * lock/store.ts), exports with the lock context, writes the merged lock back
 * atomically, and only THEN emits the bundle — a crash between the two writes
 * must never ship identities the lock hasn't recorded. `compile` and
 * `paths`/`routes` are read-only: they seed from an adjacent lock and never
 * write one, so a single-function artifact agrees with locked bundles and a
 * route listing never mints a token it would discard.
 *
 * `--no-lock` builds without one, and is refused over a lock that parses:
 * name-derived guids disagreeing with pinned ones is a delete-and-recreate.
 * The path flag is `--lock=<path>` (the `=` form only — a space-separated path
 * would be ambiguous with the entry-file positional); bare `--lock` is accepted
 * and redundant. `--frozen-lock` is the CI guard: fail instead of changing the
 * lock, so canonicals minted in CI are never silently discarded.
 */
import { writeData } from "../util/secrets.js";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
// Type-only, so the emitter module itself stays a lazy import (see the export path).
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { withAuthoringSite, withAuthoringStacks } from "./authoring-site.js";
import { checkCompiledDef } from "./compile-checks.js";
import { displayPath, pathsShownFrom, relForwardSlash } from "../util/rel-path.js";
import { emit, serializeBundle } from "./emit.js";
import {
  buildSeedContentFiles,
  registerSeedHostedFiles,
  collectNonPublicSeedValues,
  type NonPublicSeedValue,
  type SeedContentFile,
} from "../workspace/seed.js";
import { findUnresolvableFilters } from "../validate/filter-names.js";
import { bundleCapabilities } from "../validate/capabilities.js";
import type { FunctionDef } from "../function/define.js";
import { Xano, standaloneDefKind } from "../workspace/xano.js";
import { DiagnosticError, isDiagnosticError, setDiagnosticSink, type Diagnostic } from "../workspace/diagnostics.js";
import { resolveKnowledge } from "../workspace/knowledge.js";
import { installNodeLambdaChecks } from "../values/lambda-syntax.js";

// Installed before any project module loads, so every lambda body the project
// builds is checked — by this copy of the SDK or the project's own.
installNodeLambdaChecks();
import type { KnowledgeDef } from "../kinds/knowledge.js";
import { hostedFileArchivePath, hostedFileResolver } from "../workspace/hosted-file.js";
import { uncarriedHostedIcons } from "../fields/hosted-file.js";
import type { ArchiveEntry } from "../validate/archive.js";
import {
  createLockContext,
  emptyLock,
  lockKey,
  mergeObserved,
  serializeLock,
  validateLockModel,
  withoutGuidSources,
  WORKSPACE_KEY,
  displayLockKey,
  fileSpellingNote,
  toolsetKindsFromPayload,
  type LockExportContext,
  type LockEntry,
  type LockFile,
} from "../lock/lock.js";
import { readLockFile, readLockFileReport, writeLockFile } from "../lock/io.js";
import { rawDeriveGuid } from "../refs/guid.js";
import type { Bundle } from "../workspace/export.js";
import type { PositionalKind } from "./xanosdk-project.js";
import { resetLockOverrides, seedLockOverrides } from "../lock/store.js";
import { warn, info, detail, stdoutStyle, success, terminalText } from "./ui.js";
import {
  inJsonDocumentScope,
  isMachineOutput,
  jsonWarning,
  mergeJsonWarnings,
  noteRunAccepted,
  noteRunWarning,
  runAccepted,
  runWarnings,
  setRunFailureExplainer,
  writeJson,
} from "./output.js";
import { isCI } from "./agent-file-refresh.js";
import { renderGlobalHelp, renderHelpFor } from "./help.js";
import { FLAGS, GLOBAL_FLAGS, flagRefFor, flagValues, getCommand, getSubcommand, isAuthenticatedCommand, isCommand, liveSubcommandNames, REFUSES_EMPTY_DOC_TOKEN, takesProfileFlag, REFUSES_EMPTY_ENV, selectorSpellings, suggest, tablesCommand, type ArgSpec, type FlagKey } from "./commands.js";
import { assertValidProfileName } from "../auth/profile-select.js";
import { BARE, isKindShaped } from "./source-selector.js";
import { assertOneName, noteRunArgs } from "./name-argument.js";
import { backendSlotForFlag, slotValueMissing } from "./backend-slot.js";
import {
  classifyEnv,
  declaredEnv,
  defaultWorkspaceEnvPath,
  parseEnvFile,
  readWorkspaceEnvFile,
  WORKSPACE_ENV_FILE,
  projectRootFrom,
  safeNames,
  isRepresentableName,
  namesInEnvExample,
  type EnvResolution,
} from "./workspace-env.js";
import {
  documentationScopeFlagLabel,
  documentationScopeLabel,
  WORKSPACE_SECRETS_FILE,
  type SecretsRemedy,
  type DocumentationTokenDeclaration,
} from "../workspace/documentation-token.js";
import { defaultWorkspaceSecretsPath, readSecretsFile } from "./secrets-file.js";
import { contextFlags, setHintContext } from "./context-flags.js";
import { pastePath } from "./typed-cwd.js";
import { withCliPrefix } from "./invocation.js";
import { LocalFileNotFoundError } from "./bundle-input.js";
import { inCredentialScope, lastResolvedAuth, pinnedWorkspaceMissed } from "../util/last-credential.js";
import { readEnvVar } from "../util/env.js";
import { expandHome } from "../util/home-path.js";
import { allLandings, getEnvironment, readEphemeralState, type EnvScope } from "../deploy/ephemeral-state.js";
import { isExpired } from "../deploy/ephemeral.js";
import { readTrackedBackend } from "./tracked-backend.js";
import type { AnyWarningCode } from "../codes.js";
import { shellWord } from "./command-line.js";
import { isUnwritableError, unwritableError } from "./writable.js";
import {
  UsageError,
  isUsageError,
  CliError,
  envSetArgumentsRefused,
  failureCode,
  extraArguments,
  flagName,
  missingArgument,
  unknownCommand,
  unknownFlag,
  unknownHelpTopic,
  unknownSubcommand,
  movedVerb,
  type HelpTarget,
} from "./errors.js";

export interface ParsedArgs {
  command: string | undefined;
  /**
   * The verb of a noun-verb command (`workspace export`, `profile me`): here
   * `command` is the noun and `subcommand` is the verb.
   * Undefined for the single-token verbs (`compile`/`export`/`lock`/…).
   */
  subcommand: string | undefined;
  file: string | undefined;
  out: string | undefined;
  /**
   * The command line as parsed (global flags typed in front already moved
   * behind the command), for a hint that re-says the WHOLE command — a retry
   * that dropped the run's own flags would refuse, or do something else.
   * Absent on args built by hand (tests).
   */
  argv?: readonly string[];
  /** All non-flag arguments after the command (file is positionals[0]). */
  positionals: string[];
  /**
   * Where in {@link argv} each positional was typed, by the parser's own
   * reading: a rerun that leaves one out (`env set`'s secret value) removes it
   * by position — a search by value found an equal flag value first.
   */
  positionalArgv?: readonly number[];
  /**
   * `--lock` / `--lock=<path>`.
   *
   * The lock is maintained by DEFAULT, so the bare form no longer opts into
   * anything — it is accepted and redundant, because scaffolded trees and
   * examples still pass it and erroring on them buys nothing. The flag survives
   * for `--lock=<path>`, which is the real remaining job: naming the lock file
   * when the default (beside the entry) is not the one you mean.
   */
  lock: boolean;
  /** The `--lock=<path>` override (default: `xano.lock` beside the entry). */
  lockPath: string | undefined;
  /**
   * `--no-lock`: build with NO lock at all — nothing read, nothing written,
   * identities derived from names.
   *
   * The escape hatch for a throwaway run and for a tree with no lock that
   * cannot be written. It is REFUSED over a parseable lock (see
   * `compileBundle`): honoring it there would emit name-derived guids that
   * disagree with the pinned ones, which is a delete-and-recreate against
   * whatever the bundle is released to, reported as success.
   */
  noLock: boolean;
  /**
   * `--entry=<path>`: the workspace entry the lock sits beside, for the `lock`
   * subcommands that take no entry file of their own (`rename`/`adopt`).
   *
   * Distinct from `--lock`, which names the lock FILE directly. This names the
   * entry and lets the default be DERIVED the way `export` and `prune` derive
   * it — so the caller still supplied the anchor and nothing is guessed.
   */
  entryPath: string | undefined;
  /** `--frozen-lock`: hard-fail if the export would change the lock (CI). */
  frozenLock: boolean;
  /**
   * `--allow-lock-orphans`: keep `--frozen-lock` from failing over entries no
   * exported object matches. For a workspace adopted with `lock import` and
   * ported to TypeScript a piece at a time, where the unported objects are
   * live and their pinned identities must NOT be pruned away.
   */
  allowLockOrphans: boolean;
  /**
   * Not a flag: set by a command whose compile only answers a question — the
   * drift comparison of `release create`, a `reset-tables` dry run. The build
   * reads the lock exactly as a real one does, so its identities are the ones a
   * release would send, and writes nothing: no lock, no "commit it" notice.
   */
  lockReadOnly?: boolean;
  /**
   * `--strict`: promote every export/deploy WARNING to a hard failure — the
   * build diagnostics (a `bulk.update` that zero-fills omitted columns, an
   * `ignoreEmpty` that drops its predicate) as well as the CLI's own
   * preflights (unresolvable filter names; a stale `--emit`
   * manifest). Warnings print either way; `--strict` decides whether a printed
   * one still ships.
   */
  strict: boolean;
  /** `--yes`/`-y`: confirm destructive lock maintenance non-interactively. */
  yes: boolean;
  /**
   * `--check`: the reporting half of a command whose default is to act.
   * `upgrade --check` reports whether a newer `@xano/sdk` is published and
   * exits non-zero when one is, instead of installing it. `export --check` runs
   * every check an export runs and fails instead of changing the lock, but
   * writes nothing — no bundle, no lock — and so needs no secrets.
   */
  check: boolean;
  /** `push --bundle <path>`: upload an already-exported bundle instead of a file entry. */
  bundle: string | undefined;
  /** True when `bundle` came from the positional `<file>` (a `.json`), not `--bundle`: a refusal names what was typed. */
  bundlePositional?: boolean;
  /**
   * `deploy --reset`: replace the environment and re-seed it. Only changes
   * anything alongside {@link keepData}, which it overrides.
   */
  reset: boolean;
  /**
   * `deploy --keep-data`: merge into the environment an earlier deploy filled,
   * keeping its table rows, instead of replacing it. Falls back to a seeded
   * replace when there is nothing to keep. Refused with `--to`, which merges
   * already.
   */
  keepData: boolean;
  /**
   * `test --on <backend>`: which backend a suite runs on. Kept as the raw
   * string; the command parses it against the slot the registry declares.
   * Refused on every other command as undeclared.
   */
  on: string | undefined;
  /** `test --kind unit|workflow`: narrow to one test family (default: both). */
  kind: "unit" | "workflow" | undefined;
  /** `test run-all --concurrency <n>`: how many tests to run at once (default 1). */
  concurrency: number | undefined;
  /** `deploy --test`: run the environment's tests after the deploy lands. */
  test: boolean;
  /** `deploy --expires-hours <n>`: ephemeral create-time TTL (1–24, default 1 server-side). */
  expiresHours: number | undefined;
  /**
   * `routes --emit <path>`: write the generated route module there instead of
   * printing the table. Plain data + one interpolator, importing nothing, so a
   * frontend gets the typed path/verb contract without the SDK runtime.
   */
  /** `compile --export <name>`: which named export of a several-def module to compile. */
  exportName: string | undefined;
  emit: string | undefined;
  /** `deploy --static <dir>`: archive this directory and deploy it to the environment's static host. */
  static: string | undefined;
  /**
   * `deploy --static-env KEY=VALUE` (repeatable): public config baked into EVERY
   * html document of the static build as `window.<KEY>` globals. The backend URL is
   * wired in automatically as `window.XANO_HOST`; these override/extend it.
   * Served to the browser verbatim — public values only, never secrets.
   */
  staticEnv: Record<string, string>;
  /**
   * `--env-var KEY=VALUE` (repeatable): one BACKEND workspace environment
   * variable, merged over `workspaceConfig({ env })` for this run.
   *
   * The opposite of `--static-env` in every way that matters, and NOT the same
   * thing as a backend selector (`--to`/`--from`/`--on`). `--static-env`
   * bakes PUBLIC config into the html a browser downloads; this sets a workspace
   * secret the engine reads server-side with `env("NAME")`, and the value exists
   * only in this process — never written to disk, never in the repo, never
   * printed back. Highest precedence: it beats both files.
   */
  envVars: Record<string, string>;
  /**
   * `--backend-env-file <path>`: backend env values read from a dotenv-style
   * `KEY=VALUE` file INSTEAD of the default `xano/.env`.
   *
   * It REPLACES the default rather than layering over it: pointing at a CI
   * secret mount must not also ship whatever is in a developer's local file.
   */
  envFile: string | undefined;
  /**
   * `--allow-empty-env=NAME[,NAME]`: declared names this run may send empty.
   *
   * Per-name on purpose. A global opt-out would be found by exactly the person
   * under time pressure whose pipeline just refused, and would then silently
   * clear any name added upstream afterwards — re-enabling the corruption the
   * refusal exists to prevent, while reporting it as expected.
   */
  allowEmptyEnv: readonly string[];
  /**
   * `--allow-empty-doc-token=<scope>`: scopes this run may send empty, clearing
   * that doc site's gate on the target. Repeat the flag for more than one.
   *
   * Separate from {@link ParsedArgs.allowEmptyEnv} on purpose: excusing a
   * backend env var and opening a doc site are different decisions, and one flag
   * covering both would let a user who meant the first do the second.
   *
   * The scope is `workspace` or an API group's NAME — what a user can type from
   * what they can see. Not comma-split, unlike `--allow-empty-env`: a group name
   * is a remote string and may contain a comma, and a name nobody can address is
   * a gate nobody can open.
   */
  allowEmptyDocToken: readonly string[];
  /**
   * `--doc-token <scope>=<value>`: one documentation token, inline.
   *
   * For CI, which has no `xano/.secrets.json` because that file is gitignored.
   * Wins over whichever file supplied the same scope, exactly as `--env-var`
   * does. Prefer `--secrets-file` where possible: a value on the command line
   * lands in shell history, in the process argument list, and in any CI log that
   * echoes the command.
   *
   * Keyed by the same scope label the opt-out takes, and split on the FIRST `=`
   * so the TOKEN may contain one — base64 values end in `=` padding, and any
   * other split would truncate exactly the values most likely to be passed here.
   * A group NAME containing `=` cannot be addressed by this flag as a result;
   * the sidecar reaches it by guid, which has no such problem.
   */
  docTokens: Record<string, string>;
  /**
   * `--secrets-file <path>`: read documentation tokens from here instead of the
   * default `xano/.secrets.json`.
   *
   * REPLACES the default rather than layering over it, the rule `--backend-env-file`
   * already sets: pointing at a CI secret mount must not also ship a developer's
   * local file.
   */
  secretsFile: string | undefined;
  /** `--backend-dir <path>`: the directory a `pull` replaces, when discovery cannot name it. */
  backendDir: string | undefined;
  /**
   * `pull --no-secrets`: find the documentation tokens, report them, write none.
   *
   * For a machine where a secret on disk is not wanted — a shared box, a CI
   * checkout that only needs the source. The tree is unaffected: it declares the
   * gates either way, and a later deploy refuses rather than clearing one.
   */
  noSecrets: boolean;
  /**
   * `deploy --static-host <name>`: the static-host NAME to deploy the frontend
   * to (default `default`). Give each app a distinct host so deploys don't share
   * and overwrite one `default` host — the shared host is why a first post-deploy
   * load can serve a *previous* app's cached `index.html`.
   */
  staticHost: string | undefined;
  /**
   * `deploy --static-routing spa|multipage`: override how the host resolves URLs
   * within the build. Normally unset — the shape is inferred from the bundle.
   * Set it for a single-document site that wants real 404s, or a bundle carrying
   * a stray `.html` that should still route entirely client-side.
   */
  staticRouting: "spa" | "multipage" | undefined;
  /** `--origin <origin>`: Xano control-plane OAuth host. Default: $XANO_ORIGIN, then https://app.xano.com. */
  authHost: string | undefined;
  /** `--config <path>`: explicit credential file. Default: $XANO_CONFIG, then ./.xano/auth.json. */
  authFile: string | undefined;
  /**
   * `--local-auth`: use the project-local `./.xano/auth.json` cache instead of the
   * shared `~/.xanosdk/auth.json` one (the default). `login --local-auth` writes
   * there; other commands read it. Without `--local-auth`, reads still prefer an
   * existing project-local cache before falling back to the global one, so a
   * `--local-auth` project keeps working without repeating the flag.
   */
  local: boolean;
  /** `logout --all`: clear every stored profile, not just the active one. */
  all: boolean;
  /**
   * `profile add --workspace-id <n>`: the numeric workspace a stored meta API
   * token acts on. Kept as the raw STRING so the validator can quote what was
   * actually typed rather than `NaN` — the same reason the env triple does.
   */
  workspaceId: string | undefined;
  /**
   * `--profile <name>` / `-p <name>`: which stored credential profile to act as.
   *
   * `undefined` means the flag was not given — deliberately NOT collapsed into
   * the name `default`, because the rungs below it (the project's
   * `xano.profile.json`, `$XANO_PROFILE`, the credential file's own `default`
   * key) each need to know that nobody typed one. Resolved in exactly one
   * place, `getAccessToken`.
   *
   * This is the ONE rung above the project's pin, and the only way to act as a
   * profile the pinned project did not choose — which is why it discloses the
   * override rather than being refused.
   */
  profile: string | undefined;
  /**
   * `ephemeral list --all-workspaces`: enumerate ephemeral tenants across every
   * workspace on the instance, not just the token's parent workspace.
   */
  allWorkspaces: boolean;
  /** `impersonate --guest`/`-g`: mint a read-only guest session (browse only). */
  guest: boolean;
  /** `impersonate --url-only`/`-u`: print the dashboard URL instead of opening a browser. */
  urlOnly: boolean;
  /** `marketplace details --prompt`: print the add-on's agent prompt alone, for piping. */
  prompt: boolean;
  /** `login --port <n>`: loopback callback port (default: `DEFAULT_PORT`, 47100). */
  port: number | undefined;
  /**
   * `login --paste`: skip the loopback callback server and read the redirect back
   * from the user, for a host whose 127.0.0.1 the browser cannot reach (remote
   * shell, container, Codespace). Distinct from `XANO_NO_BROWSER`, which only
   * suppresses the browser launch and still needs the redirect to arrive.
   */
  paste: boolean;
  /** `login --scope "<space list>"`: OAuth scopes to request (default: the built-in xano-cli set). */
  scope: string | undefined;
  /** `preflight --runtime`: after import + round-trip, run each deployed function and report. */
  runtime: boolean;
  /** `preflight --capture`: write each round-tripped function's fetched JSON (candidate fixtures). */
  capture: boolean;
  /** `local cache clear --legacy-runtime`: remove the runtime copies earlier builds left in the user's own cache directory. */
  legacyRuntime: boolean;
  /** `preflight --verbose`: print full diffs / raw engine detail instead of a projected summary. */
  verbose: boolean;
  /** `preflight --instance <url>`: override XANO_VALIDATE_INSTANCE for this run. */
  instance: string | undefined;
  /**
   * `--format <json|multidoc>`: which artifact to emit (validated at parse
   * time). `multidoc` asks the engine to render the environment it already has
   * (`ephemeral export` only).
   */
  format: "json" | "multidoc" | undefined;
  /** `<env> export --path <p>`: output location (`-` for stdout; a dir or a full file path). */
  path: string | undefined;
  /** `<env> export --name <n>`: output basename override. Also the `init` app name (default: target dir basename). */
  name: string | undefined;
  /** `init` `--no-agents-md`: do not write the `AGENTS.md` agent brief. */
  noAgentsMd: boolean;
  /**
   * `init` `--marketplace <pkg>` (repeatable, comma-separated): marketplace
   * add-ons to install into the new project and register in `xano/index.ts`.
   *
   * One flag rather than a follow-up command so that the whole project is one
   * reproducible line — which is the promise onboarding makes when it prints
   * the command it ran. Validated in `init-modules.ts`, not at parse time.
   */
  marketplace: string[];
  /**
   * `init --from <source>`: where `xano/` comes from — `workspace`,
   * `ephemeral:<name>`, or a path to a bundle JSON already on disk. Undefined
   * writes the empty-but-valid starter backend instead.
   *
   * Kept as the raw string here and resolved in `init-command.ts`, so the one
   * place that knows the spellings is the one that reports a bad one.
   */
  from: string | undefined;
  /**
   * `init` `--framework <id>`: which frontend to scaffold
   * (`react`/`svelte`). Undefined = prompt in a TTY, else the default.
   * Validated in `frontend-presets.ts`, not at parse time.
   */
  framework: string | undefined;
  /**
   * `init` `--theme <id>`: the shadcn/ui palette to render into the
   * scaffold's stylesheet — a `<base>` or `<base>-<accent>` pair, a registry
   * theme URL, or a path to a registry item JSON file. Undefined = plain
   * shadcn. Validated in `theme-presets.ts`, not at parse time.
   */
  theme: string | undefined;
  /** `init` `--radius <len>`: corner radius override, bare number = rem. */
  radius: string | undefined;
  /**
   * `init` `--dark <mode>`: what switches the scaffold into its dark
   * palette — `system` (default), `toggle`, or `off`.
   */
  dark: string | undefined;
  /** `init` `--font <id>`: the body typeface (Tailwind's `--font-sans`). */
  font: string | undefined;
  /** `init` `--font-mono <id>`: the code typeface. */
  fontMono: string | undefined;
  /** `init` `--font-heading <id>`: the heading typeface; absent inherits the body face. */
  fontHeading: string | undefined;
  /** `init` `--icons <id>`: the icon set (`lucide` default, `tabler`, `phosphor`). */
  icons: string | undefined;
  /** `init` `--force`: scaffold into a non-empty target directory (overwrite our own files). */
  force: boolean;
  /** `init` `--no-install`: skip the post-scaffold `npm install`. Under `--from` this also means the round trip cannot be verified, since loading the tree needs its dependencies. */
  noInstall: boolean;
  /**
   * `deploy --skip-liveness`: skip the post-deploy liveness checks. Everything
   * is still deployed; Xano SDK just doesn't wait to confirm it came up — neither
   * that the edge is serving *this* static build (via `X-Xano-Canonical`) nor
   * that the workspace's microservices reached a ready state. Useful for fast
   * iterative deploys or when the deployed URL isn't reachable from the CLI host.
   */
  skipLiveness: boolean;
  /**
   * `init --from … --skip-roundtrip`: skip the offline check that the tree just
   * written re-exports as the bundle it was decoded from. Entirely local — no
   * network, no deploy, no workspace mutation — which is why it is not the same
   * flag as {@link skipLiveness} despite both once being spelled `--no-verify`.
   */
  skipRoundtrip: boolean;
  /**
   * `lock prune --identity-only`: drop the named entries without loading the
   * entry file. Separate from the other two flags, and the least related to
   * them: nothing is verified either way, the question is
   * whether the workspace is evaluated at all.
   */
  identityOnly: boolean;
  /**
   * `deploy --require-microservices`: fail the deploy when a microservice has
   * not reported ready by the end of the wait, not just when the engine says it
   * is broken. A microservice the engine reports as FAILED already exits
   * non-zero without this — the flag is what turns "still starting" into a
   * failure too, which is the reading CI wants.
   */
  requireMicroservices: boolean;
  /**
   * `init --from … --report <grouped|full|json>`: how the findings are rendered.
   *
   * `grouped` (the default) prints one line per distinct root cause with a count
   * and a collapsed object list; `full` prints every site; `json` prints the
   * findings as data for a CI gate to read. The findings themselves are the same
   * set in all three — this chooses the rendering, never what is reported.
   */
  report: string | undefined;
  /**
   * `deploy --no-dev-env`: do not point the project's dev env file
   * (`.env.local`) at the backend this deploy made. The write is a managed
   * block that leaves the rest of the file alone, so the opt-out is for the
   * developer who wants that variable to stay exactly where they put it —
   * pinned at a colleague's environment, say, or at a Xano Engine.
   */
  noDevEnv: boolean;
  /**
   * `deploy --to … --dry-run`: print what the deploy WOULD change and exit without
   * sending it. A destructive deploy previews anyway; this is how you preview
   * one that isn't, or preview without being prompted.
   */
  dryRun: boolean;
  /**
   * `deploy --to … --prune`: also delete objects this project landed on the target and
   * no longer defines. Without it a merge only adds and updates, so
   * something deleted from your code lingers in the workspace.
   */
  prune: boolean;
  /**
   * `deploy --to … --reset-data`: empty every table the bundle carries before
   * importing. Pair with `--seed` to reload the bundle's rows afterwards;
   * alone it leaves the tables empty.
   */
  resetData: boolean;
  /**
   * `deploy --to … --seed`: write the bundle's table rows into the workspace. Off by
   * default, so a deploy cannot overwrite live data you did not ask it to.
   */
  seed: boolean;
  /**
   * `workspace reset-tables --table <guid>`: which tables to reset, by guid.
   *
   * Repeatable, and a LIST rather than a comma-joined string: a table name may
   * contain a comma and a guid is the only safe key, so nothing here is ever
   * split on a separator. Absent rather than empty when the flag was not given,
   * so "named no tables" and "named zero tables" stay the same refusal.
   */
  table?: string[];
  /**
   * `workspace reset-tables --write`: actually perform the reset.
   *
   * The INVERSE of the usual `--dry-run`, and deliberately so: this empties a
   * table on a real workspace, so the outcome of forgetting the flag has to be
   * the harmless one. Every other destructive command in this CLI is guarded by
   * a confirmation the user answers; this one is guarded by a flag they have to
   * type, and then the confirmation as well.
   */
  write: boolean;
  /**
   * `release create --seed=<guids>`: which tables' rows to carry, by guid.
   *
   * A SEPARATE field from {@link seed} rather than widening it, because `seed`
   * is a single global boolean the deploy path reads as `records`. Widening it
   * would make `xanosdk deploy --seed=<guid>` parse as a bare true with the value
   * silently dropped — the failure the parser refuses for `--format`.
   *
   * Guids, not ids and not names. A stale id almost always EXISTS on the next
   * backend and resolves to a real but different table; a stale guid is absent
   * from the listing and refuses. See `TableSummary.guid`. Raw here; validated
   * and resolved to that host's ids against the SOURCE's own table listing by
   * the command.
   */
  seedTableGuids: string | undefined;
  /**
   * `deploy --to … --replace`: wipe the workspace (objects, table data and history)
   * and import the bundle in its place, instead of merging.
   * Named rather than implicit so it can never be reached by accident.
   */
  replace: boolean;
  /**
   * `deploy --to … --branch <label>`: land on this branch instead of the live one.
   *
   * The staging boundary for a workspace that has no second workspace. Branches
   * scope LOGIC only — see {@link allowSharedSchemaChanges}.
   */
  branch: string | undefined;
  /**
   * `deploy --to … --branch <label> --set-live`: promote the branch the moment the
   * import lands, in the same call.
   */
  setLive: boolean;
  /**
   * `promote --set-live --expect-live <label>`: refuse unless `<label>` is the
   * live branch — before landing, and again immediately before switching.
   */
  expectLive: string | undefined;
  /**
   * `release transfer --to-profile <name>`: the stored credential profile whose
   * instance and workspace receive the release. Resolved on its own, beside the
   * credential the command runs as, which stays the source.
   */
  toProfile: string | undefined;
  /**
   * `deploy --to … --branch <label> --allow-shared-schema-changes`: proceed even
   * though the bundle changes tables or microservices.
   *
   * Those carry no branch dimension, so they reach PRODUCTION whichever branch
   * is targeted. A separate flag rather than a prompt, because the failure mode
   * is not knowing — and `--yes` in CI answers a prompt without reading it.
   */
  allowSharedSchemaChanges: boolean;
  /**
   * `deploy --to … --replace --allow-branch-deletion`: proceed even though the clear
   * will permanently delete the workspace's non-live branches.
   *
   * The engine's clear deletes by WORKSPACE, so every branch goes, and nothing
   * brings one back — the same statement clears the saved versions that would
   * otherwise be the way back. A separate flag rather than a prompt, for the
   * same reason as {@link allowSharedSchemaChanges}: the failure mode is not
   * knowing, and `--yes` in CI answers a prompt without reading it.
   */
  allowBranchDeletion: boolean;
  /**
   * `deploy --to … --backup-branch[=<label>]`: clone the live branch before importing,
   * so a bad promote is one `set-live` away from being undone.
   */
  backupBranch: string | boolean | undefined;
  /**
   * `deploy --to <destination>`: reach a REAL destination — `workspace`, or
   * `tenant:<name>` — instead of the throwaway environment a deploy defaults to.
   *
   * The documented escape hatch from the release flow, and deliberately a flag
   * rather than a default: the recommended paths to a real destination are
   * `promote` and `tenant deploy`, which go through a release. Absent, a deploy
   * writes to an ephemeral and cannot reach anything else.
   */
  to: string | undefined;
  /**
   * `deploy` to the Xano Engine on THIS machine: the default for a deploy that
   * names no other destination, and what `--local` asks for explicitly.
   *
   * A DESTINATION, not a modifier — mutually exclusive with {@link to} and
   * {@link ephemeral}.
   */
  localEngine: boolean;
  /** `deploy --ephemeral`: send this deploy to a disposable ephemeral on Xano's cloud instead. */
  ephemeral: boolean;
  /**
   * `deploy --local=<version|url|path>`: an OVERRIDE engine — a
   * published version (`v0.1.8`, the `v` optional), an `http(s)` URL to fetch it
   * from, or the path to an engine archive already on disk (`~` and relative
   * paths both resolve). An override never reads or writes the project's pin
   * and skips the update check. XANOSDK_ENGINE_OVERRIDE supplies the same
   * value from the environment when the flag carries none.
   *
   * Absent (a bare `--local`), the run uses the project's pinned engine
   * version from `package.json` (`"xanosdk": { "@xano/sdk": { "engine" } }`),
   * or on the first run the latest published engine, which it then pins. A
   * newer published engine is offered on a terminal and never applied without
   * an explicit yes.
   */
  localEngineUrl: string | undefined;
  /**
   * `local update --version <v>` / `local cache clear --version <v>`:
   * the engine version to move the pin to, or the cached one to remove. Taken as
   * typed; the command normalizes it (`0.1.5` → `v0.1.5`). Only the first token
   * spells the CLI's own version (`xanosdk --version`), so this cannot collide.
   */
  engineVersion: string | undefined;
  /** `release create --description <text>`: what this release is for. */
  description: string | undefined;
  /**
   * `publish --release <name>`: the release whose frontend this is. Context, not
   * content — a release carries no frontend, so this only names what the
   * publish is checked and reported against.
   */
  release: string | undefined;
  /**
   * `--json`: force the machine-readable JSON on stdout even at a terminal.
   * Absent, the format is inferred from stdout being a TTY. Read through
   * `isMachineOutput` (output.ts) — never by re-checking `isTTY` at a call site.
   */
  json: boolean;
  /**
   * `--no-refresh`: skip the agent-guidance refresh a compile runs as a
   * courtesy. Global, because that courtesy rides on `export`, `deploy`,
   * `release`, and `preflight` alike — and it writes to the user's tree, so
   * "build without touching my files" has to be sayable on any of them.
   */
  noRefresh: boolean;
  /**
   * `deploy --open`: open the deployed URL in the default browser once it lands.
   * Honors `XANO_NO_BROWSER` like every other launch, since it shares the same
   * helper.
   */
  open: boolean;
  /**
   * Leading-dash tokens the parser doesn't recognize. They are collected HERE
   * rather than falling into {@link positionals} so an unknown flag can never be
   * resolved as the entry `<file>`: otherwise `xanosdk deploy --help` is
   * imported as a module path and dies in Node's loader with a message about a
   * missing file named `--help`.
   */
  unknownFlags: string[];
}

/**
 * A numeric flag's value as a plain decimal whole number, or `undefined`.
 * Stricter than `Number()`, which also reads `0x2`, `1e1`, ` 2` and `24.0`.
 */
function wholeNumber(raw: string | undefined): number | undefined {
  return raw !== undefined && /^-?\d{1,15}$/.test(raw) ? Number(raw) : undefined;
}

/** Parse a `--port` value, rejecting NaN/out-of-range so `server.listen` never gets `NaN`. */
function parsePort(raw: string | undefined): number {
  const n = wholeNumber(raw);
  if (n === undefined || n < 0 || n > 65535) {
    // Only `login` takes `--port`, so its help is the one to point at — the
    // footer every other login usage error carries.
    throw new UsageError(`--port must be an integer 0-65535 (got "${raw ?? ""}").`, { hintFor: { command: "login" } });
  }
  return n;
}

/** Nouns that take a verb as a second token (`xanosdk <noun> <verb> …`). */
const NOUN_COMMANDS = new Set([
  "profile",
  "env",
  "secrets",
  "ephemeral",
  "local",
  "workspace",
  "marketplace",
  "test",
  "release",
  "tenant",
]);

/**
 * The help block that belongs with a parse-time failure: as specific as the
 * tokens seen so far allow, and undefined (no block) when the command itself
 * isn't recognizable — a global command dump under a flag error is noise.
 */
function helpTargetFor(command: string | undefined, subcommand: string | undefined): HelpTarget | undefined {
  if (command === undefined || !isCommand(command)) return undefined;
  return subcommand !== undefined && getSubcommand(command, subcommand) !== undefined
    ? { command, subcommand }
    : { command };
}

/**
 * A selector flag given no value. When the command declares the slot, the
 * error lists that slot's own spellings; otherwise it says what the flag names
 * and leaves the refusal of the flag itself to the post-loop checks.
 */
function selectorValueMissing(
  key: "on" | "to" | "from",
  spelling: string,
  command: string | undefined,
  subcommand: string | undefined,
): UsageError {
  const slot = backendSlotForFlag(command, subcommand, key);
  if (slot !== undefined) return slotValueMissing(slot);
  const noun = key === "to" ? "a destination" : key === "from" ? "a source" : "a backend";
  return new UsageError(`${spelling} expects ${noun}.`, { helpFor: helpTargetFor(command, subcommand) });
}

/**
 * A value flag given no value (see `valueAfter` in `parseArgs`). Worded from
 * the flag's registry spec, so the placeholder help shows — `--out, -o <path>`
 * — is the one the error asks for.
 */
function throwValueMissing(
  spelling: string,
  command: string | undefined,
  subcommand: string | undefined,
  attachedEmpty = false,
): never {
  const spec = Object.values(FLAGS).find((f) => f.spec.split(/[\s,=[]+/).includes(spelling))?.spec;
  const placeholder = spec?.match(/<[^>]*>/)?.[0] ?? "a value";
  // The long spelling, for the attached form: `-o` has none of its own.
  const long = spec?.split(/[\s,=[]+/)[0] ?? spelling;
  throw new UsageError(
    // `--config=` WAS the attached form, so pointing at it read as the fix it
    // already was. It is an empty value, and is said to be one.
    attachedEmpty
      ? `\`${spelling}=\` gives \`${spelling}\` an empty value — it expects ${placeholder}: \`${long}=${placeholder}\`.`
      : `\`${spelling}\` expects ${placeholder}, and none was given. ` +
          `A value that starts with \`-\` goes attached: \`${long}=${placeholder}\`.`,
    { helpFor: helpTargetFor(command, subcommand) },
  );
}

/**
 * `-p=beta` → `--profile=beta`: the attached form of a VALUE-taking short flag,
 * spelled as its long flag so the loop's `--x=` branch reads it. Read off the
 * registry spec (`--profile, -p <name>`), so every such short is covered; a
 * boolean short (`-y=…`) is left alone and refused as the unknown token it is.
 */
export function expandShortAttached(arg: string): string {
  const m = /^(-[A-Za-z])=([\s\S]*)$/.exec(arg);
  if (m === null) return arg;
  const [, short, value] = m;
  const spec = Object.values(FLAGS).find((f) => f.spec.split(/[\s,=[]+/).includes(short!))?.spec;
  if (spec === undefined || !/<[^>]*>/.test(spec)) return arg;
  return `${spec.split(/[\s,=[]+/)[0]!}=${value!}`;
}

/**
 * Every spelling a command-scoped flag is typed as, keyed to its registry row —
 * read off each row's `spec` (`--out, -o <path>` → `--out`, `-o`), so a flag
 * added to {@link FLAGS} is covered without being listed here.
 *
 * The global rows are left out: they are accepted everywhere and never refused,
 * and the global `--version` would otherwise shadow the engine verb's.
 */
const SCOPED_FLAG_SPELLINGS: ReadonlyMap<string, FlagKey> = new Map(
  (Object.keys(FLAGS) as FlagKey[])
    .filter((key) => !(GLOBAL_FLAGS as readonly string[]).includes(key))
    .flatMap((key) =>
      FLAGS[key].spec
        .split(/[\s,=[]+/)
        .filter((token) => /^--?[a-z]/.test(token))
        .map((token) => [token, key] as const),
    ),
);

/** How many positionals an argument list accepts — unbounded for a variadic tail. */
function maxPositionals(args: readonly ArgSpec[] | undefined): number {
  if (args === undefined) return 0;
  return args.some((a) => a.variadic === true) ? Number.POSITIVE_INFINITY : args.length;
}

/**
 * The keys a JavaScript object treats as its own machinery. `--static-env
 * __proto__=x` and `--env-var __proto__=x` were accepted and silently dropped
 * (assigning `__proto__` sets a prototype, it stores nothing), and `constructor`
 * / `prototype` shadow what every object carries — so all three are refused as
 * names, before anything is stored.
 */
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * What an env var name may be — the shape the backend's own editor accepts
 * (letters, digits and `_`, not starting with a digit), which is also the only
 * shape `xano/.env` can hold. Said wherever a name is refused, so the rule
 * reads the same from `--env-var`, `workspaceConfig({ env })` and the file.
 */
export function envNameRule(): string {
  return "A name is letters, digits and `_`, and does not start with a digit (e.g. STRIPE_KEY).";
}

/** Names, quoted and neutralized for a terminal — a space or a leading digit has to be visible. */
function quotedNames(names: readonly string[]): string {
  return names.map((n) => `"${safeNames([n])}"`).join(", ");
}

function refuseReservedKey(flag: string, key: string): void {
  if (!RESERVED_OBJECT_KEYS.has(key)) return;
  throw new Error(
    `${flag} KEY cannot be \`${key}\` — \`__proto__\`, \`constructor\` and \`prototype\` are reserved ` +
      `JavaScript object keys, not names a value can be stored under. Choose another name.`,
  );
}

/**
 * How many positionals this invocation may carry, per the command registry —
 * the one place that knows, so the count can never drift from the usage line
 * that documents it.
 *
 * `undefined` means "do not check": the command or verb is unknown or removed,
 * and the dispatch chain's own error for that says something the reader can act
 * on, where an arity complaint about a command that does not exist would not.
 * Same for a noun given no verb at all — `no subcommand given` is the answer.
 *
 * `offset` exists for `lock`, the one family whose verb rides in
 * `positionals[0]` rather than being peeled off into `subcommand` (see
 * lock-commands.ts): its budget is the verb's own arguments, measured from
 * position 1.
 */
function positionalBudget(
  command: string,
  subcommand: string | undefined,
  positionals: readonly string[],
): { max: number; given: readonly string[]; offset: number; target: { command: string; subcommand?: string } } | undefined {
  const spec = getCommand(command);
  if (spec === undefined) return undefined;
  if (spec.subcommands === undefined) {
    return { max: maxPositionals(spec.args), given: positionals, offset: 0, target: { command } };
  }
  const offset = command === "lock" ? 1 : 0;
  const verb = offset === 1 ? positionals[0] : subcommand;
  if (verb === undefined) return undefined;
  const sub = getSubcommand(command, verb);
  if (sub === undefined) return undefined;
  return {
    max: maxPositionals(sub.args),
    given: positionals.slice(offset),
    offset,
    target: { command, subcommand: verb },
  };
}

/**
 * The flags whose value names one remote object — a backend selector, a
 * release, a branch, a display name — each refused when it holds a control
 * character or several lines, before any command runs (see `name-argument.ts`).
 */
const NAMING_FLAGS: ReadonlyArray<readonly [keyof ParsedArgs, string]> = [
  ["to", "`--to`"],
  ["from", "`--from`"],
  ["on", "`--on`"],
  ["release", "`--release`"],
  ["name", "`--name`"],
  ["branch", "`--branch`"],
  ["expectLive", "`--expect-live`"],
  ["backupBranch", "`--backup-branch`"],
];

function assertNamingFlags(args: ParsedArgs): void {
  for (const [key, flag] of NAMING_FLAGS) {
    const value = args[key];
    if (typeof value === "string") assertOneName(value, `the ${flag} value`, { args });
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...afterCommand] = argv;
  // Noun-verb commands (`workspace export`, `profile me`) peel
  // the verb off before flag parsing so the entry `<file>` stays positionals[0].
  let subcommand: string | undefined;
  let rest = afterCommand;
  if (command !== undefined && NOUN_COMMANDS.has(command)) {
    subcommand = afterCommand[0];
    rest = afterCommand.slice(1);
  }
  let out: string | undefined;
  let lock = false;
  let lockPath: string | undefined;
  let noLock = false;
  let entryPath: string | undefined;
  let frozenLock = false;
  let allowLockOrphans = false;
  let strict = false;
  let yes = false;
  let check = false;
  let bundle: string | undefined;
  let reset = false;
  let keepData = false;
  let on: string | undefined;
  let kind: "unit" | "workflow" | undefined;
  let concurrency: number | undefined;
  let test = false;
  let expiresHours: number | undefined;
  let staticDir: string | undefined;
  let to: string | undefined;
  let localEngine = false;
  let ephemeral = false;
  let localEngineUrl: string | undefined;
  let engineVersion: string | undefined;
  let description: string | undefined;
  let release: string | undefined;
  let staticHost: string | undefined;
  let staticRouting: "spa" | "multipage" | undefined;
  // Null-prototype maps: a user-chosen key lands as a key. On a plain `{}`,
  // `m["__proto__"] = v` is a prototype set, not a store — the pair vanished.
  const staticEnv = Object.create(null) as Record<string, string>;
  const envVars = Object.create(null) as Record<string, string>;
  let envFile: string | undefined;
  const allowEmptyEnv: string[] = [];
  const allowEmptyDocToken: string[] = [];
  const docTokens = Object.create(null) as Record<string, string>;
  let secretsFile: string | undefined;
  let backendDir: string | undefined;
  let noSecrets = false;
  let authHost: string | undefined;
  let authFile: string | undefined;
  let all = false;
  let workspaceId: string | undefined;
  let profile: string | undefined;
  // Distinct from `profile !== undefined`: a bare trailing `--profile` consumed
  // nothing, and must be reported as a missing value rather than as unset.
  let profileSeen = false;
  let useLocal = false;
  let paste = false;
  let allWorkspaces = false;
  let guest = false;
  let urlOnly = false;
  let prompt = false;
  let port: number | undefined;
  let scope: string | undefined;
  let runtime = false;
  let capture = false;
  let legacyRuntime = false;
  let verbose = false;
  let instance: string | undefined;
  let format: "json" | "multidoc" | undefined;
  /** `--format`'s value as typed, read once the command is known. */
  let formatRaw: { value: string | undefined } | undefined;
  let path: string | undefined;
  let name: string | undefined;
  let noAgentsMd = false;
  let aiSeen = false;
  const marketplace: string[] = [];
  let from: string | undefined;
  let framework: string | undefined;
  let theme: string | undefined;
  let radius: string | undefined;
  let dark: string | undefined;
  let font: string | undefined;
  let fontMono: string | undefined;
  let fontHeading: string | undefined;
  let icons: string | undefined;
  let force = false;
  let noInstall = false;
  let skipLiveness = false;
  let skipRoundtrip = false;
  let identityOnly = false;
  let requireMicroservices = false;
  let report: string | undefined;
  let noDevEnv = false;
  let dryRun = false;
  let prune = false;
  let resetData = false;
  let seed = false;
  // Undefined until the flag appears, so a run that named no table is
  // distinguishable from one that named none — the refusal wording differs.
  let table: string[] | undefined;
  let write = false;
  let seedTableGuids: string | undefined;
  let replace = false;
  let branch: string | undefined;
  let setLive = false;
  let expectLive: string | undefined;
  let toProfile: string | undefined;
  let allowSharedSchemaChanges = false;
  let allowBranchDeletion = false;
  let backupBranch: string | boolean | undefined;
  let emit: string | undefined;
  let exportName: string | undefined;
  let json = false;
  let noRefresh = false;
  let open = false;
  const positionals: string[] = [];
  /**
   * Where in `rest` each positional came from, so an unexpected one can name
   * the token it followed. `--lock path` is the case that matters: `--lock` is
   * a boolean whose value form is `=`-only, so the path lands here instead, and
   * without the neighbour there is nothing to distinguish it from a typo.
   */
  const positionalAt: number[] = [];
  const unknownFlags: string[] = [];
  // Whether this command accepts flags the registry cannot know about, so the
  // loop carries them through to the command instead of refusing them.
  //
  // It carries the FLAG only, never the token after it. Whether a deferred flag
  // takes a value is a question the parser cannot answer — the module that
  // declares it is not loaded yet — and guessing either way is wrong in a way
  // that is hard to see: swallowing costs `init --commit myapp` its target
  // directory (the scaffold silently lands in `.`), while not swallowing leaves
  // a value sitting in `positionals`. So value-taking plugin flags must be
  // written `--flag=value`; `plugin-questions.ts` says so when it meets the
  // bare form, and a stray token is caught by the ordinary arity check.
  // Read from the SUBCOMMAND as well as the command. A noun command whose verbs
  // disagree — `marketplace install` takes plugin flags, `list` and `details`
  // refuse everything they do not model — must declare it per verb, or the
  // deferral would silently discard a typo on the three verbs that never run a
  // questionnaire.
  const deferUnknown =
    command !== undefined &&
    (getCommand(command)?.deferUnknownFlags === true ||
      (subcommand !== undefined &&
        getSubcommand(command, subcommand)?.deferUnknownFlags === true));
  // One rule for every flag that takes a SEPARATED value: the value is missing
  // at the end of argv, and missing when the next token is itself a flag — it is
  // not swallowed as the value. Dropped instead, `export x.ts --out` printed to
  // stdout and `routes x.ts --emit` only listed, each reporting success for a
  // run that did not do what was typed. A lone `-` is a value (`--path -` is
  // stdout); any other value that starts with `-` goes attached (`--x=-v`).
  //
  // `valueAfter` returns undefined WITHOUT consuming, for the flags that word
  // their own refusal; `requireValue` refuses with the flag's registry
  // placeholder, for the ones that have none; `attachedValue` refuses the empty
  // `--x=` form of the same.
  let i = 0;
  const valueAfter = (): string | undefined => {
    const next = rest[i + 1];
    if (next === undefined || (next.startsWith("-") && next !== "-")) return undefined;
    i += 1;
    return next;
  };
  // A numeric flag's value: also takes a negative number (`-1`), which no flag
  // spells, so its parser reports the value given rather than none.
  const numberAfter = (): string | undefined => (/^-\d/.test(rest[i + 1] ?? "") ? rest[++i] : valueAfter());
  const requireValue = (spelling: string): string =>
    valueAfter() ?? throwValueMissing(spelling, command, subcommand);
  const attachedValue = (arg: string, prefix: string): string => {
    const value = arg.slice(prefix.length);
    return value !== "" ? value : throwValueMissing(prefix.slice(0, -1), command, subcommand, true);
  };
  // Every registry flag this argv spelled, for the declared-flags check after
  // the loop. A value `valueAfter` consumed never reaches the loop head, so a
  // token recorded here is always a flag, never another flag's value.
  const spelled = new Map<FlagKey, string>();
  // `--` ends the options, as everywhere: what follows is positional, dashes
  // and all — never refused as "Unknown flag --".
  let optionsEnded = false;
  for (; i < rest.length; i++) {
    if (optionsEnded || rest[i] === "--") {
      if (optionsEnded) {
        positionals.push(rest[i]!);
        positionalAt.push(i);
      }
      optionsEnded = true;
      continue;
    }
    const arg = expandShortAttached(rest[i]!);
    const spelling = arg.split("=", 1)[0]!;
    const key = SCOPED_FLAG_SPELLINGS.get(spelling);
    if (key !== undefined && !spelled.has(key)) spelled.set(key, spelling);
    if (arg === "--out" || arg === "-o") {
      out = requireValue(arg);
    } else if (arg.startsWith("--out=")) {
      out = attachedValue(arg, "--out=");
    } else if (arg === "--export") {
      exportName = requireValue(arg);
    } else if (arg.startsWith("--export=")) {
      exportName = attachedValue(arg, "--export=");
} else if (arg === "--emit") {
      emit = requireValue(arg);
    } else if (arg.startsWith("--emit=")) {
      emit = attachedValue(arg, "--emit=");
    } else if (arg === "--no-lock") {
      noLock = true;
    } else if (arg === "--lock") {
      lock = true;
    } else if (arg.startsWith("--lock=")) {
      lock = true;
      lockPath = arg.slice("--lock=".length);
    } else if (arg === "--entry") {
      entryPath = requireValue(arg);
    } else if (arg.startsWith("--entry=")) {
      entryPath = attachedValue(arg, "--entry=");
    } else if (arg === "--frozen-lock") {
      frozenLock = true;
    } else if (arg === "--allow-lock-orphans") {
      allowLockOrphans = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg === "--check") {
      check = true;
    } else if (arg === "--bundle") {
      bundle = requireValue(arg);
    } else if (arg.startsWith("--bundle=")) {
      bundle = attachedValue(arg, "--bundle=");
    } else if (arg === "--reset") {
      reset = true;
    } else if (arg === "--keep-data") {
      keepData = true;
    } else if (arg === "--env" || arg.startsWith("--env=")) {
      // Renamed, not removed: agents arrive with cached docs, and "Unknown flag
      // --env" would send them to the did-you-mean list instead of the fix. The
      // `--no-verify` precedent below is the same shape.
      throw new UsageError(
        "`--env` was renamed `--on` on `test`; other commands name a backend with `--to`, `--from`, " +
          "or a positional.",
        { helpFor: helpTargetFor(command, subcommand) },
      );
    } else if (arg === "--on" || arg.startsWith("--on=")) {
      const value = arg === "--on" ? valueAfter() : arg.slice("--on=".length);
      // A missing value must not fall through as `undefined` — that is the
      // "use the tracked backend" signal, so `--on $UNSET` would silently run
      // on a different backend than the one that was asked for.
      if (value === undefined || value === "") throw selectorValueMissing("on", "--on", command, subcommand);
      on = value;
    } else if (arg === "--kind") {
      kind = parseKind(valueAfter());
    } else if (arg.startsWith("--kind=")) {
      kind = parseKind(arg.slice("--kind=".length));
    } else if (arg === "--concurrency") {
      concurrency = parseConcurrency(numberAfter());
    } else if (arg.startsWith("--concurrency=")) {
      concurrency = parseConcurrency(arg.slice("--concurrency=".length));
    } else if (arg === "--test") {
      test = true;
    } else if (arg === "--expires-hours") {
      expiresHours = parseExpiresHours(numberAfter());
    } else if (arg.startsWith("--expires-hours=")) {
      expiresHours = parseExpiresHours(arg.slice("--expires-hours=".length));
    } else if (arg === "--static-env" || arg.startsWith("--static-env=")) {
      const kv = arg === "--static-env" ? valueAfter() : arg.slice("--static-env=".length);
      const eq = kv?.indexOf("=") ?? -1;
      if (kv === undefined || eq <= 0) {
        throw new Error(`--static-env expects KEY=VALUE (got "${kv ?? ""}").`);
      }
      const key = kv.slice(0, eq);
      // Served as `window.<KEY>`, so KEY is a JavaScript identifier: `bad key`
      // or `X</script>` was accepted and reported as `window.bad key`, a global
      // no page can read as written. Only the name is quoted, never the value.
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
        throw new Error(
          `--static-env KEY must be a JavaScript identifier — letters, digits, \`_\` or \`$\`, not starting ` +
            `with a digit — because it is served as \`window.<KEY>\` (got ${JSON.stringify(key)}).`,
        );
      }
      refuseReservedKey("--static-env", key);
      staticEnv[key] = kv.slice(eq + 1);
    } else if (arg === "--env-var" || arg.startsWith("--env-var=")) {
      const kv = arg === "--env-var" ? valueAfter() : arg.slice("--env-var=".length);
      const eq = kv?.indexOf("=") ?? -1;
      if (kv === undefined || eq <= 0) {
        // The token is echoed only when it carries no `=` at all. `eq === 0` is
        // `--env-var =SECRET`, an empty KEY half — echoing that would put the
        // VALUE on stderr, which is the one thing this family must never do.
        const got = eq === 0 ? "an empty name" : `"${kv ?? ""}"`;
        throw new Error(
          `--env-var expects KEY=VALUE (got ${got}). It sets a BACKEND workspace ` +
            `variable the engine reads with env("NAME"); for public frontend config use ` +
            `\`deploy --static-env\`, and to choose which backend a command acts on use its selector ` +
            `(\`--to\`, \`--from\`, \`--on\`, or its positional).`,
        );
      }
      refuseReservedKey("--env-var", kv.slice(0, eq));
      // `--env-var 'bad key=…'` was sent, landed on the backend, and then
      // `env pull` could not write it back — see {@link envNameRule}.
      if (!isRepresentableName(kv.slice(0, eq))) {
        throw new Error(`--env-var: ${quotedNames([kv.slice(0, eq)])} is not a usable env var name. ${envNameRule()}`);
      }
      // Last-wins let `--env-var=SECRET=x --env-var SECRET=` send the empty
      // one and report "1 value supplied". Neither value is repeated here.
      if (Object.hasOwn(envVars, kv.slice(0, eq))) {
        throw new UsageError(
          `--env-var names ${quotedNames([kv.slice(0, eq)])} more than once. Give each name once — ` +
            `which of the values was meant cannot be guessed.`,
          { hintFor: helpTargetFor(command, subcommand) },
        );
      }
      envVars[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (arg === "--env-file" || arg.startsWith("--env-file=")) {
      // Node reads `--env-file` anywhere on its command line, even after the
      // script, and loads it into the CLI's OWN environment (or exits 9 on a
      // missing file) — so the CLI rarely sees it. When it does arrive, say so.
      throw new UsageError(
        "`--env-file` was renamed `--backend-env-file`: Node itself claims `--env-file` and loads " +
          "that file into the CLI's own environment before the CLI runs.",
        // The message names the replacement; a pointer, not the whole block.
        { hintFor: helpTargetFor(command, subcommand) },
      );
    } else if (arg === "--backend-env-file" || arg.startsWith("--backend-env-file=")) {
      const value = arg === "--backend-env-file" ? valueAfter() : arg.slice("--backend-env-file=".length);
      if (value === undefined || value === "") {
        throw new Error(
          "--backend-env-file expects a path (e.g. `--backend-env-file ci.env`). It REPLACES the default " +
            "xano/.env for this run.",
        );
      }
      envFile = value;
    } else if (arg === "--allow-empty-env" || arg.startsWith("--allow-empty-env=")) {
      // A BARE form is refused. The flag says which live values it is allowed to
      // clear, and a global one would be adopted under pressure and then clear
      // any name added upstream afterwards — silently, and as expected output.
      const value = arg.startsWith("--allow-empty-env=")
        ? arg.slice("--allow-empty-env=".length)
        : "";
      const names = value
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n !== "");
      if (names.length === 0) {
        throw new Error(
          "--allow-empty-env expects the NAMES it may clear (e.g. " +
            "`--allow-empty-env=STRIPE_KEY,SENTRY_DSN`). There is deliberately no bare form: it " +
            "would also clear whatever names the backend gains later.",
        );
      }
      allowEmptyEnv.push(...names);
    } else if (arg === "--allow-empty-doc-token" || arg.startsWith("--allow-empty-doc-token=")) {
      // Same discipline as `--allow-empty-env`, and no bare form for the same
      // reason: a global opt-out would be adopted under pressure and then clear
      // the gate on whatever doc site the workspace gains later.
      const value = (
        arg.startsWith("--allow-empty-doc-token=")
          ? arg.slice("--allow-empty-doc-token=".length)
          : ""
      ).trim();
      // NOT comma-split, unlike `--allow-empty-env`. A scope here is an API
      // group's name, which comes from a backend with nothing constraining its
      // shape — splitting on commas would make a group called `Orders, v2`
      // unaddressable, and an unaddressable gate is one nobody can open.
      if (value === "") {
        throw new Error(
          "--allow-empty-doc-token expects the SCOPE it may clear — `workspace`, or an API " +
            "group's name (e.g. `--allow-empty-doc-token=\"Public API\"`). Repeat the flag for " +
            "more than one. There is deliberately no bare form: it would also clear the gate on " +
            "whatever doc sites the workspace gains later.",
        );
      }
      allowEmptyDocToken.push(value);
    } else if (arg === "--doc-token" || arg.startsWith("--doc-token=")) {
      const pair = arg === "--doc-token" ? valueAfter() : arg.slice("--doc-token=".length);
      // Split on the FIRST `=`: the scope is a group name that may contain one,
      // and a token certainly may.
      const eq = pair === undefined ? -1 : pair.indexOf("=");
      // An empty VALUE is refused too, not just an empty name. Supplying `""`
      // through the flag that exists to SUPPLY a token would clear the gate
      // silently, past the opt-out whose whole job is to make that deliberate.
      if (pair === undefined || eq <= 0 || pair.slice(eq + 1) === "") {
        throw new Error(
          "--doc-token expects `<scope>=<value>` — `workspace=…`, or an API group's name " +
            '(e.g. `--doc-token "Public API=sk_…"`). Repeat the flag for more than one. ' +
            "An empty value is refused: to clear a gate on purpose, say so with " +
            '`--allow-empty-doc-token="<scope>"`. Prefer `--secrets-file <path>` for a real ' +
            "value: one here is visible in shell history, in the process list, and in any CI " +
            "log that echoes the command.",
        );
      }
      docTokens[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
    } else if (arg === "--no-secrets") {
      noSecrets = true;
    } else if (arg === "--secrets-file" || arg.startsWith("--secrets-file=")) {
      const value = arg === "--secrets-file" ? valueAfter() : arg.slice("--secrets-file=".length);
      if (value === undefined || value === "") {
        throw new Error("--secrets-file expects a path to a documentation-token file.");
      }
      secretsFile = value;
    } else if (arg === "--backend-dir" || arg.startsWith("--backend-dir=")) {
      const value = arg === "--backend-dir" ? valueAfter() : arg.slice("--backend-dir=".length);
      // A missing value must NOT fall through as `undefined` — that is the
      // "discover the backend directory" signal, and `pull` REPLACES whatever it
      // resolves. `--backend-dir $UNSET` would silently clear the discovered
      // directory instead of the named one.
      if (value === undefined || value === "") {
        throw new Error("--backend-dir expects the path of a backend directory inside this project.");
      }
      backendDir = value;
    } else if (arg === "--to" || arg.startsWith("--to=")) {
      const value = arg === "--to" ? valueAfter() : arg.slice("--to=".length);
      // A missing value must NOT fall through as `undefined` — that is the
      // "deploy to an ephemeral" signal, so `--to $UNSET` would send a deploy
      // aimed at a real destination to a throwaway environment and report
      // success. Same hazard as `--branch` below, in the other direction.
      if (value === undefined || value === "") throw selectorValueMissing("to", "--to", command, subcommand);
      to = value;
    } else if (arg === "--ephemeral") {
      ephemeral = true;
    } else if (arg === "--local" || arg.startsWith("--local=")) {
      // `env set|unset` took a boolean `--local` before a Xano Engine
      // was a selector kind. Dropping it silently would turn `env set K v
      // --local` into a write to the tracked ephemeral, so it names the
      // new spelling instead.
      if (command === "env" && (subcommand === "set" || subcommand === "unset")) {
        throw new UsageError("`--local` here is `--to local`.", {
          helpFor: helpTargetFor(command, subcommand),
        });
      }
      localEngine = true;
      if (arg.startsWith("--local=")) {
        const value = arg.slice("--local=".length);
        if (value === "") {
          throw new UsageError(
            "--local= expects an engine version (v0.1.5), a URL to fetch the engine " +
              "from, or the path to an engine archive on this machine.",
          );
        }
        localEngineUrl = value;
      } else if (
        /^https?:\/\//.test(rest[i + 1] ?? "") ||
        /\.(tar\.gz|tgz)$/i.test(rest[i + 1] ?? "") ||
        /^v?\d+\.\d+\.\d+$/.test(rest[i + 1] ?? "")
      ) {
        // The value is OPTIONAL, so a separated one is taken only when it could
        // not be anything else. `xanosdk deploy --local ./xano/index.ts`
        // names the entry file, and swallowing it would turn a normal deploy
        // into a download from a path that is not a URL.
        //
        // An archive SUFFIX is the same test in the other form, and it is safe
        // for the same reason: an entry file ends `.ts` or `.js`, never
        // `.tar.gz` or `.tgz`, so the two cannot collide. Without it the form a
        // tester actually types — `--local ~/Downloads/engine.tar.gz` —
        // drops the value silently and then refuses with "no engine cached".
        // A bare version (`v0.1.8`) cannot be an entry file either.
        localEngineUrl = rest[++i];
      }
    } else if (arg === "--description" || arg.startsWith("--description=")) {
      const value = arg === "--description" ? valueAfter() : arg.slice("--description=".length);
      if (value === undefined || value === "") {
        throw new Error("--description expects text (e.g. `--description \"what shipped\"`).");
      }
      description = value;
    } else if (arg === "--release" || arg.startsWith("--release=")) {
      const value = arg === "--release" ? valueAfter() : arg.slice("--release=".length);
      // Same hazard as `--to`: an empty value must not read as "no release
      // context", which would publish unchecked a frontend the caller meant to pair.
      if (value === undefined || value === "") {
        throw new Error("--release expects a release name (`xanosdk release list` shows them).");
      }
      release = value;
    } else if (arg === "--static-host") {
      staticHost = requireValue(arg);
    } else if (arg.startsWith("--static-host=")) {
      staticHost = attachedValue(arg, "--static-host=");
    } else if (arg === "--static-routing" || arg.startsWith("--static-routing=")) {
      const v = arg === "--static-routing" ? valueAfter() : arg.slice("--static-routing=".length);
      if (v !== "spa" && v !== "multipage") {
        throw new Error(`--static-routing expects "spa" or "multipage" (got "${v ?? ""}").`);
      }
      staticRouting = v;
    } else if (arg === "--static") {
      staticDir = requireValue(arg);
    } else if (arg.startsWith("--static=")) {
      staticDir = attachedValue(arg, "--static=");
    } else if (arg === "--origin") {
      authHost = requireValue(arg);
    } else if (arg.startsWith("--origin=")) {
      authHost = attachedValue(arg, "--origin=");
    } else if (arg === "--config") {
      authFile = expandHome(requireValue(arg));
    } else if (arg.startsWith("--config=")) {
      authFile = expandHome(attachedValue(arg, "--config="));
    } else if (arg === "--local-auth") {
      useLocal = true;
    } else if (arg === "--paste") {
      paste = true;
    } else if (arg === "--version" || arg.startsWith("--version=")) {
      const value = arg === "--version" ? valueAfter() : arg.slice("--version=".length);
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new UsageError(`--version expects an engine version, like \`--version v0.1.5\`.`, {
          helpFor: helpTargetFor(command, subcommand),
        });
      }
      engineVersion = value;
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--all-workspaces") {
      allWorkspaces = true;
    } else if (arg === "--guest" || arg === "-g") {
      guest = true;
    } else if (arg === "--url-only" || arg === "-u") {
      urlOnly = true;
    } else if (arg === "--prompt") {
      prompt = true;
    } else if (arg === "--port") {
      port = parsePort(numberAfter());
    } else if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
    } else if (arg === "--scope") {
      scope = requireValue(arg);
    } else if (arg.startsWith("--scope=")) {
      scope = attachedValue(arg, "--scope=");
    } else if (arg === "--runtime") {
      runtime = true;
    } else if (arg === "--capture") {
      capture = true;
    } else if (arg === "--legacy-runtime") {
      legacyRuntime = true;
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--instance") {
      instance = requireValue(arg);
    } else if (arg.startsWith("--instance=")) {
      instance = attachedValue(arg, "--instance=");
    } else if (arg === "--workspace-id") {
      workspaceId = requireValue(arg);
    } else if (arg.startsWith("--workspace-id=")) {
      workspaceId = attachedValue(arg, "--workspace-id=");
    } else if (arg === "--format" || arg.startsWith("--format=")) {
      const value = arg === "--format" ? valueAfter() : arg.slice("--format=".length);
      formatRaw = { value };
    } else if (arg === "--path") {
      path = requireValue(arg);
    } else if (arg.startsWith("--path=")) {
      path = attachedValue(arg, "--path=");
    } else if (arg === "--report") {
      report = requireValue(arg);
    } else if (arg.startsWith("--report=")) {
      report = attachedValue(arg, "--report=");
    } else if (arg === "--name") {
      name = requireValue(arg);
    } else if (arg.startsWith("--name=")) {
      name = attachedValue(arg, "--name=");
    } else if (arg === "--framework") {
      framework = requireValue(arg);
    } else if (arg.startsWith("--framework=")) {
      framework = attachedValue(arg, "--framework=");
    } else if (arg === "--theme") {
      theme = requireValue(arg);
    } else if (arg.startsWith("--theme=")) {
      theme = attachedValue(arg, "--theme=");
    } else if (arg === "--radius") {
      radius = requireValue(arg);
    } else if (arg.startsWith("--radius=")) {
      radius = attachedValue(arg, "--radius=");
    } else if (arg === "--dark") {
      dark = requireValue(arg);
    } else if (arg.startsWith("--dark=")) {
      dark = attachedValue(arg, "--dark=");
    // The two compound font flags are matched BEFORE bare `--font`, or
    // `--font-mono` would be read as `--font` with the value "-mono".
    } else if (arg === "--font-mono") {
      fontMono = requireValue(arg);
    } else if (arg.startsWith("--font-mono=")) {
      fontMono = attachedValue(arg, "--font-mono=");
    } else if (arg === "--font-heading") {
      fontHeading = requireValue(arg);
    } else if (arg.startsWith("--font-heading=")) {
      fontHeading = attachedValue(arg, "--font-heading=");
    } else if (arg === "--font") {
      font = requireValue(arg);
    } else if (arg.startsWith("--font=")) {
      font = attachedValue(arg, "--font=");
    } else if (arg === "--icons") {
      icons = requireValue(arg);
    } else if (arg.startsWith("--icons=")) {
      icons = attachedValue(arg, "--icons=");
    } else if (arg === "--from" || arg.startsWith("--from=")) {
      const value = arg === "--from" ? valueAfter() : arg.slice("--from=".length);
      // A missing value must not fall through as `undefined` — that is the
      // "write the empty starter" signal, so `--from $UNSET` would scaffold a
      // starter over a directory the caller meant to fill from a workspace.
      if (value === undefined || value === "") throw selectorValueMissing("from", "--from", command, subcommand);
      from = value;
    } else if (arg === "--marketplace" || arg.startsWith("--marketplace=")) {
      // Accumulated and comma-split, so both spellings work and a
      // printed command can carry every add-on on one line.
      const raw = arg === "--marketplace" ? requireValue(arg) : attachedValue(arg, "--marketplace=");
      for (const p of raw.split(",")) {
        const pkg = p.trim();
        if (pkg !== "") marketplace.push(pkg);
      }
    } else if (arg === "--no-agents-md") {
      noAgentsMd = true;
    } else if (arg === "--ai" || arg.startsWith("--ai=")) {
      // The per-tool presets this selected collapsed into the one AGENTS.md,
      // and callers that drive `init` programmatically — the `--web`
      // configurator among them — still send it: `none` is `--no-agents-md`,
      // and every preset name means the AGENTS.md that is written anyway.
      // Scoped to `init` below, like every flag the registry declares.
      aiSeen = true;
      const raw = arg === "--ai" ? requireValue(arg) : attachedValue(arg, "--ai=");
      if (raw.split(",").some((p) => p.trim().toLowerCase() === "none")) noAgentsMd = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--no-install") {
      noInstall = true;
    } else if (arg === "--no-dev-env") {
      noDevEnv = true;
    } else if (arg === "--skip-liveness") {
      skipLiveness = true;
    } else if (arg === "--skip-roundtrip") {
      skipRoundtrip = true;
    } else if (arg === "--identity-only") {
      identityOnly = true;
    } else if (arg === "--no-verify") {
      // Split three ways. Which replacement applies depends on the command, and
      // a bare "unknown flag" would leave the reader to work that out — while
      // silently accepting it would skip a check they never asked to skip.
      throw new UsageError(
        `\`--no-verify\` was split into three flags that each name what they skip: ` +
          `\`--skip-liveness\` (deploy: waiting for the deploy to come up), ` +
          `\`--skip-roundtrip\` (init --from: the offline re-export check), and ` +
          `\`--identity-only\` (lock prune: loading the entry file).`,
        { helpFor: helpTargetFor(command, subcommand) },
      );
    } else if (arg === "--require-microservices") {
      requireMicroservices = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--prune") {
      // A real flag on `deploy` now, where it scopes the merge `--to` performs.
      // It was scoped to the retired `release` verb precisely so that a bare
      // `deploy --prune` still reached the removed-flag message below; that
      // message is about the destination flags only, and `--prune` is out
      // of its list.
      prune = true;
    } else if (arg === "--reset-data") {
      resetData = true;
    } else if (arg === "--write") {
      write = true;
    } else if (arg === "--table" || arg.startsWith("--table=")) {
      // Repeatable. Each occurrence adds ONE guid — never split on a separator,
      // because the only safe key for a table is its guid and a name (which a
      // user may paste by mistake) can contain anything at all.
      const value = arg.startsWith("--table=") ? arg.slice("--table=".length) : valueAfter();
      if (value === undefined || value === "") {
        throw new UsageError(`\`--table\` needs a table guid. Run \`${tablesCommand("workspace")}\` to list them.`);
      }
      table = [...(table ?? []), value];
    } else if (arg === "--seed") {
      seed = true;
    } else if (arg.startsWith("--seed=")) {
      seed = true;
      // Kept as the raw string, including an empty one: `--seed=` is a usage
      // error rather than a silent "all tables", and only the validation below
      // can tell those apart.
      seedTableGuids = arg.slice("--seed=".length);
    } else if (arg === "--replace") {
      replace = true;
    } else if (arg === "--branch" || arg.startsWith("--branch=")) {
      const value = arg === "--branch" ? valueAfter() : arg.slice("--branch=".length);
      // A missing value must NOT fall through as `undefined` — that is the
      // "release to the live branch" signal, so `--branch $UNSET` would release
      // straight to production with every branch guard skipped.
      if (value === undefined || value === "") {
        throw new Error("--branch expects a branch label (e.g. `--branch staging`).");
      }
      branch = value;
    } else if (arg === "--set-live") {
      setLive = true;
    } else if (arg === "--expect-live" || arg.startsWith("--expect-live=")) {
      const value = arg === "--expect-live" ? valueAfter() : arg.slice("--expect-live=".length);
      // A missing value must not fall through as `undefined`: that is "no
      // precondition", so `--expect-live $UNSET` would switch live unguarded.
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new Error("--expect-live expects the label of the branch you expect to be live (e.g. `--expect-live main`).");
      }
      expectLive = value;
    } else if (arg === "--to-profile" || arg.startsWith("--to-profile=")) {
      const value = arg === "--to-profile" ? valueAfter() : arg.slice("--to-profile=".length);
      // Refused here rather than left `undefined`: a missing destination is not
      // "no destination", and `--to-profile $UNSET` must not read as one.
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw new Error("--to-profile expects the name of a stored credential profile (e.g. `--to-profile prod`).");
      }
      toProfile = value;
    } else if (arg === "--allow-shared-schema-changes") {
      allowSharedSchemaChanges = true;
    } else if (arg === "--allow-branch-deletion") {
      allowBranchDeletion = true;
    } else if (arg === "--backup-branch") {
      // Bare: the label is derived at release time (see `release-command.ts`).
      // `true` rather than a string keeps "asked for a backup" and "named the
      // backup" distinguishable, which the derived-label path needs.
      backupBranch = true;
    } else if (arg.startsWith("--backup-branch=")) {
      const value = arg.slice("--backup-branch=".length);
      // `--backup-branch=` with nothing after it reads as "derive one" rather
      // than as a branch named "", which the engine would accept and nobody
      // could then select.
      backupBranch = value === "" ? true : value;
    } else if (arg === "--no-refresh") {
      // Global, for the same reason as `--json`: the behaviour it turns off is
      // attached to the compile, not to any one command that runs one.
      noRefresh = true;
    } else if (arg === "--json") {
      // Global: accepted whatever the command, so a wrapper can ask any of them
      // for JSON without knowing which ones happen to print a table.
      json = true;
    } else if (arg === "--open") {
      open = true;
    } else if (arg === "--profile" || arg === "-p") {
      // Global, like `--json`: parsed for every command in this one loop, then
      // REFUSED below on a command that reaches no credential — an accepted and
      // silently ignored `--profile` is how a deploy lands on the wrong tenant.
      profileSeen = true;
      profile = valueAfter();
    } else if (arg.startsWith("--profile=")) {
      profileSeen = true;
      // `--profile=` is refused below, in the words bare `--profile` and
      // `-p ''` get: one missing name, one sentence.
      profile = arg.slice("--profile=".length);
    } else if (arg === "--help" || arg === "-h") {
      // Consumed so it never reaches `positionals` (and thus `file`). `run()`
      // resolves help from the raw argv before parsing — see resolveHelpRequest.
      continue;
    } else if (arg.startsWith("-") && arg !== "-") {
      // An unrecognized flag: kept out of `positionals` so it can't misparse as
      // the entry file. A bare "-" IS a real value (`--path -` means stdout).
      unknownFlags.push(arg);
    } else {
      positionals.push(arg);
      positionalAt.push(i);
    }
  }
  // `env set` takes a secret as a positional, so a value that parses as a flag
  // or splits into extra words must not be quoted back — here or at the arity
  // check below.
  const secretArgs = command === "env" && subcommand === "set";
  // Fail on an unrecognized flag rather than dropping it. Thrown
  // here, at the end of the parse, so every command inherits it from the one
  // funnel real argv passes through. `--help` never reaches this: it is
  // resolved from raw argv before `parseArgs` and consumed in the loop besides.
  //
  // A command declaring `deferUnknownFlags` is the exception, and it is
  // deferred rather than waived: it carries its unknowns through and refuses
  // whatever is left over once its plugins have had their pick. See the
  // field's doc in `commands.ts` for the obligation that creates.
  // A verb that moved to the top level, typed under its old noun. Before every
  // flag check: `ephemeral impersonate x --guest` would otherwise be refused
  // for `--guest` on a verb that no longer exists, which names the wrong fix.
  const moved = movedVerb(command, subcommand, positionals);
  if (moved !== undefined) throw moved;
  // `-p -x`: the value was a flag, so `-x` reached the unknown flags. The typed
  // mistake is the missing profile name, and "Unknown flag -x" (with a
  // suggestion for some other flag) names the wrong one — so this goes first.
  if (profileSeen && (profile === undefined || profile === "" || profile.startsWith("-"))) {
    throw new UsageError(
      // `login` CREATES the profile it names: "a stored credential profile"
      // sent its reader to a list that cannot hold it yet (E2E pass 26).
      command === "login"
        ? `\`--profile\` needs the name to sign in as, e.g. \`xanosdk login --profile staging\` — a new name ` +
            `creates that profile, an existing one signs it in again.`
        : `\`--profile\` needs the name of a stored credential profile, e.g. \`--profile staging\`. ` +
            `Run \`xanosdk profile list\` to see what is signed in.`,
      { helpFor: helpTargetFor(command, subcommand) },
    );
  }
  // `login --token`: the flag a token sign-in reaches for, and `login` is the
  // browser sign-in — a meta API token is stored by `profile add`, which reads
  // it from stdin so it never lands in shell history (E2E pass 26).
  if (command === "login" && unknownFlags.some((f) => f === "--token" || f.startsWith("--token="))) {
    throw new UsageError(
      `\`xanosdk login\` signs in through the browser and takes no token. Store a meta API token with ` +
        `\`xanosdk profile add <name> --instance <url> --workspace-id <id>\` — it prompts for the token, ` +
        `or reads it piped on stdin (\`printf %s "$TOKEN" | xanosdk profile add …\`), never from a flag.`,
      { hintFor: { command: "profile", subcommand: "add" } },
    );
  }
  if (unknownFlags.length > 0 && !deferUnknown) {
    if (secretArgs) throw envSetArgumentsRefused("flag", unknownFlags);
    throw unknownFlag(unknownFlags, helpTargetFor(command, subcommand));
  }
  // A module's flags are always `--long`, so a single-dash unknown can be no
  // module's and is refused now, even where the rest are deferred — or its
  // stray value (`init app3 -name foo`) is refused by the arity check below as
  // an "unexpected argument", naming the symptom instead of the typo (E2E pass 26).
  const shortUnknown = deferUnknown ? unknownFlags.filter((f) => !f.startsWith("--")) : [];
  if (shortUnknown.length > 0) throw unknownFlag(shortUnknown, helpTargetFor(command, subcommand));
  // `--format` is parsed for every command (one loop); which values a command
  // takes is the registry's per-command `values` — the same list help and
  // completion show — so a value a command refuses fails here, before any entry
  // loads. On a command that declares no `--format` every value is refused,
  // `json` included: the command writes its one artifact whatever was asked,
  // and that artifact is not always JSON (E2E pass 46: `release export
  // --format json` exited 0 having written XanoScript).
  // A command that takes none says so first, whatever value was typed.
  if (formatRaw !== undefined) {
    const ref = flagRefFor(command, subcommand, "format");
    const path = subcommand === undefined ? command : `${command} ${subcommand}`;
    if (ref === undefined) {
      throw new UsageError(`\`xanosdk ${path}\` takes no \`--format\` — it writes one artifact.`, {
        helpFor: helpTargetFor(command, subcommand),
      });
    }
    format = parseFormat(formatRaw.value);
    const allowed = flagValues(ref) ?? ["json"];
    if (!allowed.includes(format)) {
      const hint =
        format === "multidoc"
          ? " (the engine's rendering of a deployed env: `xanosdk ephemeral export --format multidoc`)"
          : "";
      throw new UsageError(
        `\`xanosdk ${path}\` does not render \`--format ${format}\`${hint}; it takes ${allowed.map((v) => `\`${v}\``).join(", ")}.`,
        { helpFor: helpTargetFor(command, subcommand) },
      );
    }
  }
  // A flag the parse loop accepts for EVERY command but that only some commands
  // can honour must be refused where it cannot be, not dropped: an option the
  // CLI accepts and discards reads as a reported success against the wrong
  // target, which is the shape this repo has been bitten by twice.
  //
  // Scope comes from the registry — a command declares the flag or it does not
  // — so this cannot go stale as commands are added.
  const refuseUnlessDeclared = (key: FlagKey, spelling: string, why: string, suggestion?: string): void => {
    if (command === undefined || flagRefFor(command, subcommand, key) !== undefined) return;
    const path = subcommand === undefined ? command : `${command} ${subcommand}`;
    throw new UsageError(`\`xanosdk ${path}\` takes no \`${spelling}\` — ${why}`, {
      helpFor: helpTargetFor(command, subcommand),
      ...(suggestion === undefined ? {} : { suggestion }),
    });
  };
  if (aiSeen) refuseUnlessDeclared("ai", "--ai", "it only chooses whether `init` writes AGENTS.md.");
  if (profileSeen && profile !== undefined) {
    // `--profile` is the one GLOBAL flag with a scope, so its own check reads
    // the AUTH bundle rather than a per-command declaration — it is declared on
    // none of them, deliberately, to cost one help row instead of ~35.
    if (command !== undefined && !isAuthenticatedCommand(command, subcommand)) {
      const path = subcommand === undefined ? command : `${command} ${subcommand}`;
      throw new UsageError(
        `\`xanosdk ${path}\` takes no \`--profile\` — it reaches no Xano instance, so there is no ` +
          `credential for a profile to select. The commands that take it are the ones that sign in ` +
          `(\`deploy\`, \`pull\`, \`status\`, \`whoami\`, \`tenant\`, \`release\`, …).`,
        { hintFor: helpTargetFor(command, subcommand) },
      );
    }
    if (command !== undefined && !takesProfileFlag(command, subcommand)) {
      throw new UsageError(
        `\`xanosdk ${command} ${subcommand}\` takes no \`--profile\` — the profile it acts on is its ` +
          `<name> argument: \`xanosdk ${command} ${subcommand} <name>\`.`,
        { hintFor: helpTargetFor(command, subcommand) },
      );
    }
    assertValidProfileName(profile);
  }
  if (force) {
    // A command that replaces files but asks first (`pull`) confirms with
    // `--yes`; saying it "overwrites nothing" there would be false.
    refuseUnlessDeclared(
      "force",
      "--force",
      command !== undefined && flagRefFor(command, subcommand, "yes") !== undefined
        ? "it asks before it replaces or removes anything, and `--yes` answers that confirmation in advance."
        : "it overwrites nothing that already exists. A confirmation is answered in advance with `--yes`.",
    );
  }
  if (out !== undefined) {
    refuseUnlessDeclared(
      "out",
      "--out",
      command !== undefined && flagRefFor(command, subcommand, "path") !== undefined
        ? "its output location is `--path` (a file, a directory, or `-` for stdout)."
        : "it writes no file.",
    );
  }
  if (branch !== undefined) {
    refuseUnlessDeclared(
      "branch",
      "--branch",
      // Tables are the one thing a workspace does not keep per branch, so the
      // table verbs get the reason that is true of them.
      command === "workspace" && subcommand === "reset-tables"
        ? "tables are shared by every branch of a workspace, so a reset reaches all of them and a branch would scope nothing."
        : "this command does not act on a single workspace branch, so there is nothing for a label to select.",
    );
  }
  if (name !== undefined) {
    refuseUnlessDeclared(
      "name",
      "--name",
      "a name it needs is a positional argument, or part of the backend it names " +
        "(`--on ephemeral:<name>`, `--to tenant:<name>`).",
    );
  }
  // Parsed for every command in the one loop, honoured by few. Each is refused
  // where it is undeclared rather than dropped: a dropped `--local`
  // would send a write meant for this machine to the tracked ephemeral.
  if (on !== undefined) {
    // Per command: a list of every selector spelling sent `env pull` (which
    // takes `--from` alone) to `--to` and a positional it refuses (E2E pass 26).
    const own = selectorSpellings(command, subcommand);
    refuseUnlessDeclared(
      "on",
      "--on",
      "`--on` is `test`'s selector. " +
        (own.length === 0
          ? "This command acts on no backend a selector names."
          : `This command names its backend with ${own.length === 1 ? own[0] : `${own.slice(0, -1).join(", ")} or ${own.at(-1)}`}` +
            (/^`--/.test(own[0]!) ? `: \`${own[0]!.slice(1, -1)} ${on}\`.` : ".")),
      // The flag it names, as `--json`'s `suggestion` (E2E pass 28: only the
      // message carried it).
      own.length > 0 && /^`--/.test(own[0]!) ? own[0]!.slice(1, -1) : undefined,
    );
  }
  if (localEngine) {
    refuseUnlessDeclared(
      "local",
      "--local",
      "only `deploy` takes it, because only a deploy downloads, pins and starts an engine. " +
        "Elsewhere a Xano Engine is a backend: `--to local`, `--from local`, or `local` as the positional.",
    );
  }
  if (ephemeral) {
    refuseUnlessDeclared(
      "ephemeral",
      "--ephemeral",
      "only `deploy` takes it. Elsewhere an ephemeral is a backend: `--to ephemeral`, `--from ephemeral`, or `ephemeral` as the positional.",
    );
  }
  if (command === "deploy") {
    // One destination per deploy. Refused here, before anything compiles, so
    // a run that named two never reaches either.
    if (ephemeral && localEngine) {
      throw new UsageError(
        "`--ephemeral` and `--local` are two destinations, and a deploy has one. Drop whichever is not meant.",
        { helpFor: { command: "deploy" } },
      );
    }
    if (ephemeral && to !== undefined) {
      throw new UsageError(
        "`--ephemeral` and `--to` are two destinations, and a deploy has one: `--ephemeral` replaces a " +
          "disposable ephemeral, `--to` merges into a backend that already exists. Drop whichever is not meant.",
        { helpFor: { command: "deploy" } },
      );
    }
    // The Xano Engine is where a deploy goes when it names nowhere else.
    if (!ephemeral && to === undefined) localEngine = true;
  }
  if (guest) {
    refuseUnlessDeclared(
      "guest",
      "--guest",
      "a guest session is minted only when opening a backend's dashboard (`impersonate`).",
    );
  }
  if (engineVersion !== undefined) {
    refuseUnlessDeclared(
      "engine-version",
      "--version",
      "it takes no engine version. `xanosdk --version` (as the first argument) prints the CLI's own.",
    );
  }
  if (all) {
    refuseUnlessDeclared(
      "all",
      "--all",
      "it acts on one thing. `xanosdk logout --all` is the one that means every stored profile.",
    );
  }
  if (expectLive !== undefined) {
    const takers =
      "`xanosdk promote <release> --set-live --expect-live <label>` and " +
      "`xanosdk workspace branch set-live <branch> --expect-live <label>` are the ones that take it.";
    refuseUnlessDeclared(
      "expect-live",
      "--expect-live",
      command === "deploy"
        ? `its \`--set-live\` switches live without checking what is live first. ${takers}`
        : `it switches no live branch, so there is no switch for the precondition to guard. ${takers}`,
    );
  }
  if (toProfile !== undefined) {
    refuseUnlessDeclared(
      "to-profile",
      "--to-profile",
      "it writes to the workspace its own credential is bound to. `--profile` chooses that credential; " +
        "`--to-profile` names a second, destination one, and belongs to `xanosdk release transfer`.",
    );
  }
  if (workspaceId !== undefined) {
    refuseUnlessDeclared(
      "workspace-id",
      "--workspace-id",
      "every command acts on the workspace its credential is bound to. `--workspace-id` names the " +
        "workspace a STORED meta API token addresses, and belongs to `xanosdk profile add`.",
    );
  }
  // Every other registry flag, by the same rule and without a hand list: the
  // loop parses every flag for every command, so one a command does not declare
  // would otherwise be dropped — `compile --frozen-lock` reporting a build the
  // lock never guarded. The checks above only word the reason more precisely.
  // An unknown command or verb is left alone; its own refusal says more.
  // `lock` carries its verb in `positionals[0]` (see positionalBudget).
  const commandSpec = command === undefined ? undefined : getCommand(command);
  const verb = commandSpec?.subcommands === undefined ? undefined : command === "lock" ? positionals[0] : subcommand;
  const declaring = commandSpec?.subcommands === undefined ? commandSpec : verb === undefined ? undefined : getSubcommand(command!, verb);
  if (declaring !== undefined) {
    for (const [key, spelling] of spelled) {
      // `--format` is decided above.
      if (key === "format" || flagRefFor(command, verb, key) !== undefined) continue;
      const path = verb === undefined ? command! : `${command!} ${verb}`;
      throw new UsageError(
        `\`xanosdk ${path}\` takes no \`${spelling}\` — it is not one of this command's flags, so it would change nothing.`,
        { helpFor: helpTargetFor(command, verb) },
      );
    }
  }
  // `--seed=<guids>` belongs to ONE command. Everywhere else `--seed` is a bare
  // boolean the deploy path reads as `records`, so an `=<value>` there would be
  // a request the parser accepted and then discarded — the silent-drop shape
  // `--format` is refused for. Named rather than ignored.
  if (seedTableGuids !== undefined && !(command === "release" && subcommand === "create")) {
    const path = subcommand === undefined ? command : `${command} ${subcommand}`;
    throw new UsageError(
      `\`xanosdk ${path}\` takes the bare \`--seed\`, not \`--seed=<guids>\`. Selecting which tables' ` +
        `rows to carry is \`xanosdk release create <name> --seed=<guids>\`; here \`--seed\` is all-or-nothing.`,
      { helpFor: helpTargetFor(command, subcommand) },
    );
  }
  // `--no-lock` against any flag that presumes a lock. Each says what the
  // actual disagreement is: a reader who typed both had a specific one of them
  // in mind, and a generic "these conflict" leaves them guessing which to drop.
  if (noLock && lockPath !== undefined) {
    throw new Error(
      `\`--no-lock\` and \`--lock=${lockPath}\` ask for opposite things: one builds with no lock ` +
        `at all, the other names the lock file to use. Drop \`--no-lock\` to build against ` +
        `${lockPath}, or drop \`--lock=\` to build without a lock.`,
    );
  }
  if (noLock && lock) {
    throw new Error(
      "`--no-lock` and `--lock` are contradictory. The lock is maintained by default, so `--lock` " +
        "adds nothing — drop it to keep the lock, or keep `--no-lock` alone to build without one.",
    );
  }
  if (noLock && frozenLock) {
    throw new Error(
      "`--no-lock` and `--frozen-lock` are contradictory: `--frozen-lock` asserts that the lock is " +
        "read and honored unchanged, and `--no-lock` reads no lock at all. Use `--frozen-lock` " +
        "alone in CI.",
    );
  }
  // `--env-var NAME=` sends an empty value, which clears what the target holds
  // — the one outcome every other empty value (a declared name nothing
  // supplied, `env set NAME ""`) needs `--allow-empty-env` for.
  const emptyFlagged = Object.keys(envVars).filter((n) => envVars[n] === "" && !allowEmptyEnv.includes(n));
  if (emptyFlagged.length > 0) {
    const one = emptyFlagged.length === 1;
    throw new UsageError(
      `--env-var gives ${quotedNames(emptyFlagged)} an empty value, which clears what the target holds. ` +
        `Pass \`--allow-empty-env=${emptyFlagged.join(",")}\` if clearing ${one ? "it" : "them"} is meant, ` +
        `or give ${one ? "it a value" : "each a value"}.`,
      { hintFor: helpTargetFor(command, subcommand) },
    );
  }
  // `export --check` writes nothing, so every flag that only shapes what gets
  // WRITTEN — where the bundle goes, which secrets it carries — has nothing to
  // act on. Refused rather than ignored: a CI job passing `--doc-token` here
  // believes the gate was checked against a value, and it never is. `--no-lock`
  // is not one of them: it checks a project that has no lock yet on everything
  // but the lock.
  if (command === "export" && check) {
    const pointless = [
      ...(out !== undefined ? ["--out"] : []),
      ...(envFile !== undefined ? ["--backend-env-file"] : []),
      ...(Object.keys(envVars).length > 0 ? ["--env-var"] : []),
      ...(allowEmptyEnv.length > 0 ? ["--allow-empty-env"] : []),
      ...(Object.keys(docTokens).length > 0 ? ["--doc-token"] : []),
      ...(secretsFile !== undefined ? ["--secrets-file"] : []),
      ...(allowEmptyDocToken.length > 0 ? ["--allow-empty-doc-token"] : []),
    ];
    if (pointless.length > 0) {
      throw new UsageError(
        `\`export --check\` writes no bundle, so ${pointless.map((f) => `\`${f}\``).join(", ")} ` +
          `${pointless.length === 1 ? "has" : "have"} nothing to act on. Drop ` +
          `${pointless.length === 1 ? "it" : "them"}, or drop \`--check\` to write the bundle.`,
        { hintFor: { command: "export" } },
      );
    }
    // A check never writes the lock, so it can only ever assert it — which is
    // what `--frozen-lock` is. Implied rather than required alongside, unless
    // there is no lock to assert.
    if (!noLock) frozenLock = true;
  }
  // `--allow-lock-orphans` relaxes one refusal `--frozen-lock` makes, and
  // nothing else: without the gate there is no refusal to relax, so the flag
  // would parse and change nothing — the silent-drop shape refused everywhere
  // else. After the `--check` block, which implies `--frozen-lock`.
  if (allowLockOrphans && !frozenLock) {
    const path = subcommand === undefined ? command : `${command} ${subcommand}`;
    throw new UsageError(
      `\`--allow-lock-orphans\` only relaxes \`--frozen-lock\` (or \`export --check\`, which implies it), ` +
        `so on its own it would change nothing. Add \`--frozen-lock\`, or drop the flag.`,
      { hintFor: path === undefined ? undefined : { command: command!, ...(subcommand ? { subcommand } : {}) } },
    );
  }
  // `routes --strict` is the `--emit` staleness check and nothing else; without
  // `--emit` there is no file to check, so it would parse and change nothing.
  if (strict && emit === undefined && (command === "routes" || command === "paths")) {
    throw new UsageError(
      `\`${command} --strict\` checks the file \`--emit\` names, so on its own it would change nothing. ` +
        `Add \`--emit <path>\` (e.g. \`--emit xano/routes.gen.ts\`), or drop the flag.`,
      { hintFor: { command } },
    );
  }
  // …and then on a positional the command has nowhere to put. Deliberately
  // last: an unknown command, an unknown verb and an unknown flag all say
  // something more useful than an arity complaint would, and each of those is
  // decided before this point (the first two by skipping the check entirely —
  // see positionalBudget).
  const budget = command === undefined ? undefined : positionalBudget(command, subcommand, positionals);
  if (budget !== undefined && budget.given.length > budget.max) {
    if (secretArgs) throw envSetArgumentsRefused("extra");
    // A deferred `--flag` one typo from a real one (`init app --nme foo`): its
    // value is the stray positional, so the arity count names the symptom. The
    // typo is the cause — refused as one. Only once the count has failed: a
    // module's own `--flag=value` that happens to sit near a CLI flag still
    // defers to its questionnaire (E2E pass 27).
    const longUnknown = deferUnknown ? unknownFlags.filter((f) => f.startsWith("--")) : [];
    const typo = longUnknown.length > 0 ? unknownFlag(longUnknown, helpTargetFor(command, subcommand)) : undefined;
    if (typo?.suggestion !== undefined) throw typo;
    // A positional written directly after `--lock` is the one the reader meant
    // as its value — whichever end of the line it sits at, and regardless of
    // which positional the count happens to declare surplus. `--lock` alone
    // before the entry file (`export --lock ./index.ts`) is a REAL invocation,
    // so this only speaks up once the count has already failed.
    const lockValue = positionals.findIndex((_, n) => rest[(positionalAt[n] ?? 0) - 1] === "--lock");
    const extras = lockValue >= budget.offset ? [positionals[lockValue]!] : budget.given.slice(budget.max);
    const refused = extraArguments(extras, budget.target, budget.max, lockValue >= budget.offset ? "--lock" : undefined);
    // `test run-all ephemeral`: the backend written the way `tables` takes it.
    // `test` selects it with `--on`, so the paste-ready form is named.
    const backend = extras.length === 1 && extras[0] !== undefined && isKindShapedOrBare(extras[0]) ? extras[0] : undefined;
    if (command === "test" && on === undefined && backend !== undefined) {
      refused.message +=
        ` The backend is chosen with \`--on\`: \`xanosdk test ${[subcommand, ...budget.given.slice(0, budget.max)].map((t) => shellWord(t!)).join(" ")} --on ${shellWord(backend)}\`.`;
    }
    throw refused;
  }
  // A bundle `.json` as the positional `<file>` is `--bundle`: help lists it as
  // a source, and down the entry path it was imported as a module and refused.
  // Only where the first declared argument is a path `--bundle` stands in for —
  // declaring the flag is not enough, since `release create`'s first positional
  // is a release NAME — and never for a source selector (`release:v1.json`),
  // nor beside `--bundle`, which the loader refuses as "not both".
  let file = positionals[0];
  let bundlePositional = false;
  const fileSpec = command === undefined ? undefined : subcommand === undefined ? getCommand(command) : getSubcommand(command, subcommand);
  const firstArg = fileSpec?.args?.[0];
  if (
    file !== undefined &&
    bundle === undefined &&
    /\.json$/i.test(file) &&
    firstArg?.path === true &&
    firstArg.satisfiedBy?.includes("bundle") === true &&
    !isKindShaped(file)
  ) {
    bundle = file;
    bundlePositional = true;
    file = undefined;
  }
  const parsed = {
    argv: [...argv],
    command,
    subcommand,
    file,
    out,
    positionals,
    positionalArgv: positionalAt.map((at) => at + (argv.length - rest.length)),
    lock,
    lockPath,
    seedTableGuids,
    noLock,
    entryPath,
    frozenLock,
    allowLockOrphans,
    strict,
    yes,
    check,
    bundle,
    ...(bundlePositional ? { bundlePositional } : {}),
    reset,
    keepData,
    on,
    kind,
    concurrency,
    test,
    expiresHours,
    static: staticDir,
    staticHost,
    to,
    localEngine,
    ephemeral,
    localEngineUrl,
    engineVersion,
    description,
    release,
    staticRouting,
    staticEnv,
    envVars,
    envFile,
    allowEmptyEnv,
    allowEmptyDocToken,
    docTokens,
    secretsFile,
    backendDir,
    noSecrets,
    authHost,
    authFile,
    all,
    workspaceId,
    profile,
    local: useLocal,
    paste,
    allWorkspaces,
    guest,
    urlOnly,
    prompt,
    port,
    scope,
    runtime,
    capture,
    legacyRuntime,
    verbose,
    instance,
    format,
    path,
    name,
    noAgentsMd,
    marketplace,
    from,
    force,
    noInstall,
    framework,
    theme,
    radius,
    dark,
    font,
    fontMono,
    fontHeading,
    icons,
    skipLiveness,
    skipRoundtrip,
    identityOnly,
    requireMicroservices,
    report,
    noDevEnv,
    dryRun,
    prune,
    resetData,
    seed,
    table,
    write,
    replace,
    branch,
    setLive,
    expectLive,
    toProfile,
    allowSharedSchemaChanges,
    allowBranchDeletion,
    backupBranch,
    emit,
    exportName,
    json,
    noRefresh,
    open,
    unknownFlags,
  };
  assertNamingFlags(parsed as ParsedArgs);
  return parsed;
}

/**
 * A resolved help request: the deepest command path present, or the topic word
 * that `xanosdk help <topic>` named and the registry does not know.
 */
export interface HelpRequest {
  command?: string;
  subcommand?: string;
  /** Set only for `xanosdk help <unknown>` — see {@link resolveHelpRequest}. */
  unknownTopic?: string;
  /** Set only for `xanosdk <unknown> --help` with a command-shaped word. */
  unknownCommand?: string;
  /** Set only for `xanosdk <family> <not-a-verb> --help`, beside `command`. */
  unknownSubcommand?: string;
  /** The words after {@link unknownSubcommand}, for a moved verb's rename hint. */
  positionals?: string[];
}

/**
 * Whether `tokens` are flags and nothing else — a separated flag's value
 * (`--config c.json`) counted as its flag's, so `profile add help --config c`
 * is still a bare `help`.
 */
function onlyFlags(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.startsWith("-")) return false;
    if (SEPARATED_VALUE_SPELLINGS.has(t)) i += 1;
  }
  return true;
}

/**
 * Resolve a help request straight from the RAW argv, before any flag parsing.
 *
 * Deliberately pre-parse: `parseArgs` throws on removed flags and malformed
 * values, so resolving help afterwards would mean `xanosdk deploy --profile x
 * --help` died on the flag error instead of printing the help the user asked
 * for. Returns the deepest command path present (`{}` for global help), or
 * undefined when no help was requested.
 */
export function resolveHelpRequest(argv: string[]): HelpRequest | undefined {
  const asVerb = argv[0] === "help";
  // `xanosdk deploy help`: the word as the command's only argument asks for its
  // help — read as an entry path it was "Cannot find entry file". Not for
  // `init`, whose argument is a directory to create, nor when a `help` file or
  // directory is really there to be named.
  const [first, second, ...after] = argv;
  if (
    first !== undefined &&
    first !== "init" &&
    second === "help" &&
    isCommand(first) &&
    onlyFlags(after) &&
    !existsSync("help")
  ) {
    return { command: first };
  }
  // `xanosdk marketplace install help`, `local cache help`, `profile add
  // help`: the same word after a verb, as its only argument, is that verb's
  // help — it was a package looked up on the network, an unknown cache action,
  // a profile named "help" (E2E pass 25). The same `help`-file exception.
  const [third, ...rest] = after;
  if (
    first !== undefined &&
    second !== undefined &&
    third === "help" &&
    isCommand(first) &&
    getSubcommand(first, second) !== undefined &&
    onlyFlags(rest) &&
    !existsSync("help")
  ) {
    return { command: first, subcommand: second };
  }
  if (!asVerb && !argv.some((a) => a === "--help" || a === "-h")) return undefined;
  // Non-flag tokens only. A flag's VALUE can survive this filter (`--env
  // workspace`), which is harmless: it only matters if it happens to name a real
  // command in position 0, and the command always occupies that slot first.
  const tokens = (asVerb ? argv.slice(1) : argv).filter((a) => !a.startsWith("-"));
  const command = tokens[0];
  if (command === undefined || !isCommand(command)) {
    // `xanosdk help <unknown>` NAMED a topic and still got the global dump with
    // exit 0, so a typo'd `xanosdk help deply` read as an answer. The `--help`
    // form is the same mistake when the word leads the line and is shaped like
    // a command; anything else there (`xanosdk ./index.ts --help`) is as likely
    // an entry file, where global help IS the answer.
    if (command === undefined) return {};
    if (asVerb) return { unknownTopic: command };
    return argv[0] === command && /^[a-z][a-z0-9-]*$/.test(command) ? { unknownCommand: command } : {};
  }
  const sub = tokens[1];
  if (sub !== undefined && getSubcommand(command, sub) !== undefined) return { command, subcommand: sub };
  // `xanosdk tenant create --help` printed tenant's help and exited 0, where the
  // same line without `--help` is an unknown-subcommand usage error (E2E pass
  // 17) — the help reads as though `create` were fine. A family's word right
  // after the noun that is no verb of it is that same mistake. Only when it
  // directly follows the noun: a flag's value (`--profile p`) survives the
  // token filter, and is not a verb anyone typed.
  const source = asVerb ? argv.slice(1) : argv;
  if (
    sub !== undefined &&
    liveSubcommandNames(command).length > 0 &&
    source[source.indexOf(command) + 1] === sub &&
    /^[a-z][a-z0-9-]*$/.test(sub)
  ) {
    return { command, unknownSubcommand: sub, positionals: tokens.slice(2) };
  }
  return { command };
}

/** Parse a `--format` value, rejecting anything but the supported artifacts. */
function parseFormat(raw: string | undefined): "json" | "multidoc" {
  if (raw === "json" || raw === "multidoc") return raw;
  throw new UsageError(`--format must be "json" or "multidoc" (got "${raw ?? ""}").`);
}

/** Parse a `--kind` value, rejecting anything but the two test families. */
function parseKind(raw: string | undefined): "unit" | "workflow" {
  if (raw === "unit" || raw === "workflow") return raw;
  throw new UsageError(`--kind must be "unit" or "workflow" (got "${raw ?? ""}").`);
}

/** Parse a `--concurrency` value: a positive integer, bounded so a typo cannot fan out unboundedly. */
function parseConcurrency(raw: string | undefined): number {
  const n = wholeNumber(raw);
  if (n === undefined || n < 1 || n > 32) {
    throw new Error(`--concurrency must be a whole number from 1 to 32 (got "${raw ?? ""}").`);
  }
  return n;
}

/** Parse a `--expires-hours` value, matching the server's 1–24 bound. */
function parseExpiresHours(raw: string | undefined): number {
  const n = wholeNumber(raw);
  if (n === undefined || n < 1 || n > 24) {
    throw new Error(`--expires-hours must be an integer 1–24 (got "${raw ?? ""}").`);
  }
  return n;
}

/**
 * Import tsx's ESM API, resolving it from the USER's project (the directory of
 * the `.ts` entry) rather than the CLI's own install tree.
 *
 * A bare `import("tsx/esm/api")` resolves against wherever THIS module lives: fine
 * for an `npx`/local-devDependency CLI (it sits in the project's `node_modules`),
 * but a GLOBALLY-installed CLI resolves against the global `node_modules`, which
 * has no tsx — even when the user's project has it. So resolve from the entry file
 * first (matching the tsup "tsx is the consumer's install" design), and fall back
 * to a bare import for the co-located case.
 */
async function importTsxApi(file: string): Promise<{ register: () => () => void }> {
  try {
    const requireFromEntry = createRequire(pathToFileURL(resolve(file)));
    const apiPath = requireFromEntry.resolve("tsx/esm/api");
    return (await import(pathToFileURL(apiPath).href)) as { register: () => () => void };
  } catch {
    return (await import("tsx/esm/api")) as { register: () => () => void };
  }
}

/** {@link importTsxApi}, returning `undefined` instead of throwing when tsx isn't installed. */
async function tryImportTsxApi(file: string): Promise<{ register: () => () => void } | undefined> {
  try {
    return await importTsxApi(file);
  } catch {
    return undefined;
  }
}

/**
 * Whether a TypeScript entry will be evaluated as CommonJS.
 *
 * `.mts` is always ESM and `.cts` always CJS; a bare `.ts` follows the nearest
 * package.json's `type`, where a missing `type` field (what `npm init -y`
 * writes) means CommonJS.
 *
 * Decided by inspection rather than by catching a loader's error, because the
 * error differs per loader: native Node raises a `SyntaxError` about an import
 * statement outside a module, while tsx — which respects the same `type` —
 * fails earlier, resolving `@xano/sdk` under `require` conditions and
 * reporting a missing `exports` main. Neither message tells an author what to do.
 *
 * Answers only on POSITIVE evidence. An entry with no package.json above it
 * anywhere is left alone: Node's own rule would call it CommonJS, but a host
 * with an active loader (vitest, a bundler's dev server) happily treats it as
 * ESM, and a false "add type: module" on a file that loads fine is worse than
 * the raw loader error on a genuinely broken one.
 */
function entryIsCommonJs(file: string): boolean {
  const path = resolve(file);
  if (/\.mts$/.test(path)) return false;
  if (/\.cts$/.test(path)) return true;

  let dir = dirname(path);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { type?: unknown };
        return pkg.type !== "module";
      } catch {
        // An unreadable/non-JSON package.json is not evidence of anything.
        return false;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return false; // no manifest anywhere — don't guess
    dir = parent;
  }
}

/**
 * The actionable error for an entry in a CommonJS module graph. Xano SDK defs
 * are ESM-only, so no loader can bridge this — the entry itself has to be ESM.
 */
function commonJsEntryError(file: string, cause?: unknown): Error {
  return new Error(
    `Cannot load "${file}": it is being evaluated as CommonJS, but Xano SDK ` +
      `workspace files are ES modules. Add \`"type": "module"\` to the nearest ` +
      `package.json, or rename the entry to \`.mts\`.`,
    cause !== undefined ? { cause } : undefined,
  );
}

/**
 * A did-you-mean for a typo'd entry path, drawn from the files actually sitting
 * in the directory the user pointed at. Best-effort: an unreadable (or absent)
 * directory simply yields no hint.
 */
function suggestSiblingFile(path: string): string | undefined {
  try {
    return suggest(basename(path), readdirSync(dirname(path)));
  } catch {
    return undefined;
  }
}

/**
 * The nearest ANCESTOR of the working directory under which a relative entry
 * path does exist, or undefined.
 *
 * A relative path resolves against `process.cwd()`, so running from a
 * subdirectory (a `scripts/` folder, a package inside a monorepo) turns
 * `./xano/index.ts` into `<cwd>/xano/index.ts` — a path the reader never named
 * and that does not exist. The resolved path alone does not say that: it reads
 * as "the file is gone", and when the working directory happens to sit under
 * `node_modules` it reads as a broken install. Finding the entry
 * one directory up turns the message into the actual remedy, which is `cd`.
 *
 * Absolute paths are skipped — there is nothing to re-anchor, so a miss is a
 * genuine miss. The walk stops at the filesystem root.
 */
function findEntryInAncestor(file: string): string | undefined {
  if (isAbsolute(file)) return undefined;
  let dir = dirname(resolve(file));
  // Start one level up from the directory the failed resolution named: the
  // resolution itself already tested the working directory.
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
    if (existsSync(resolve(dir, file))) return dir;
  }
}

export async function loadDefault(file: string): Promise<unknown> {
  return (await loadModule(file)).default;
}

/**
 * A module with no package.json anywhere above it resolves `@xano/sdk` under
 * CommonJS conditions, and the SDK is ESM-only — so the loader fails with its
 * own "No \"exports\" main defined in …/@xano/sdk/package.json", which names
 * the SDK's manifest as the problem. `generate --out <dir>` outside a project
 * is the usual way here. The fix is the project around the file.
 */
function noProjectEntryError(file: string, cause: unknown): Error | undefined {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  // Both ways it shows: the SDK found under CommonJS conditions, or not found at
  // all (no node_modules anywhere above either).
  const exportsMain = code === "ERR_PACKAGE_PATH_NOT_EXPORTED" || /No "exports" main defined/.test(message);
  const notFound = /Cannot find (module|package) '@xano\/sdk'/.test(message);
  if (!exportsMain && !notFound) return undefined;
  if (!/@xano[\\/]sdk/.test(message) || hasPackageJsonAbove(file)) return undefined;
  return new UsageError(
    `Cannot load "${file}": there is no package.json above it, so it is not part of a project, and ` +
      `@xano/sdk (an ES module) cannot be resolved from it. Run xanosdk on an entry inside a project ` +
      `(\`xanosdk init\` makes one, and \`xanosdk generate --out <dir>\` can write into it), or add a ` +
      `package.json with \`"type": "module"\` beside the entry, then ` +
      // tsx too: without it the very next run fails "requires `tsx`" on a .ts entry.
      `\`npm i @xano/sdk && npm i -D tsx\`.`,
  );
}

/**
 * How to get `tsx` for the project around `file`: a project whose package.json
 * already declares it has only not installed its dependencies (a fresh clone),
 * so the step is its own install — from where the command was typed. Exported for the tests.
 */
export async function tsxRemedy(file: string): Promise<string> {
  const fallback = `Install it in your project (\`npm i -D tsx\`) or precompile the file to .js first.`;
  for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
      } catch {
        return fallback;
      }
      const declared = (["devDependencies", "dependencies"] as const).some(
        (block) => typeof pkg[block] === "object" && pkg[block] !== null && "tsx" in (pkg[block] as object),
      );
      if (!declared) return fallback;
      const { detectPackageManager } = await import("./package-manager.js");
      const { inProject } = await import("./init-modules.js");
      return `This project's package.json declares it, but its dependencies are not installed — run \`${inProject(dir)}${detectPackageManager(dir)} install\` first.`;
    }
    if (dirname(dir) === dir) return fallback;
  }
}

/** Whether any directory from the entry's up to the filesystem root holds a package.json. */
function hasPackageJsonAbove(file: string): boolean {
  let dir = dirname(resolve(file));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Refuse an entry file that is not there — `SDK_USAGE`, exit 1, as every
 * missing local input. Exported so a command that reads a credential
 * (`preflight`, `workspace diff`) answers a typo before "not signed in".
 */
export function assertEntryExists(file: string): void {
  const path = resolve(file);
  if (!existsSync(path)) {
    const elsewhere = findEntryInAncestor(file);
    // Naming the working directory is the whole fix: a relative entry resolves
    // against it, and when it is the wrong one the resolved path describes a
    // missing file rather than a misplaced shell.
    const where =
      elsewhere !== undefined
        ? `A relative entry resolves against the current directory (${process.cwd()}), ` +
          `and "${file}" does exist under ${elsewhere} — run xanosdk from there.`
        : `A relative entry resolves against the current directory (${process.cwd()}).`;
    throw new LocalFileNotFoundError(
      `Cannot find entry file "${file}" (resolved to ${path}).` +
        (isAbsolute(file) ? "" : `\n  ${where}`),
      { suggestion: suggestSiblingFile(path) },
    );
  }
}

/**
 * Load an entry file with the CLI's loader, returning its whole module
 * namespace. A throw from the author's own code closes with the line that
 * threw — a factory validates before its owning def exists ({@link withAuthoringSite}).
 */
export async function loadModule(file: string): Promise<Record<string, unknown>> {
  try {
    return await withAuthoringStacks(() => loadEntryModule(file));
  } catch (err) {
    throw withAuthoringSite(err, file);
  }
}

async function loadEntryModule(file: string): Promise<Record<string, unknown>> {
  const path = resolve(file);
  // Checked before ANY loader work, tsx registration included.
  //
  // Left to `import()`, a path that simply does not exist surfaces as Node's
  // ERR_MODULE_NOT_FOUND, whose message names the module doing the resolving —
  // in a published build one of this package's own bundled chunks, which the
  // reader has no reason to have heard of. Worse for a `.ts` entry: it takes
  // the tsx branch first, and the same error code is the one the catch below
  // translates into "install tsx", sending someone to install a package that
  // was never the problem. A typo in a path is the likeliest way to reach this
  // function at all, so it answers first and in the reader's own terms.
  assertEntryExists(file);
  const url = pathToFileURL(path).href;
  const isTypeScript = /\.[mc]?ts$/.test(file);

  // Register tsx BEFORE the first import of a TypeScript entry, rather than as
  // a recovery step after one fails.
  //
  // Node's native type stripping loads a `.ts` entry but does NOT remap a `.js`
  // specifier to its `.ts` source, so a workspace's own intra-workspace imports
  // (`./tables/user.js` — the form the docs mandate) fail to resolve. The
  // native loader is therefore never the right loader for a Xano SDK entry.
  //
  // Recovering after the fact is not possible: Node CACHES the rejected module
  // resolution, so re-importing the same URL with tsx registered returns the
  // same failure, and cache-busting the entry URL does not help either because
  // the unresolvable specifier is a nested one. Reproduced on Node 22.19
  // (Node 24 happens not to cache it, which is why this hid for so long).
  //
  // Uses the global `register()` hook rather than the scoped `tsImport()`: the
  // latter resolves nested `.js`→`.ts` specifiers relative to *this* module's
  // location, so when the CLI runs from a symlinked install (`npx`, a `file:`
  // dep) the workspace's own relative imports fail to resolve. `register()`
  // installs the loader process-wide, so the whole module graph remaps
  // consistently; we unregister once the entry has loaded.
  if (isTypeScript) {
    // Check this before loading: under tsx the CommonJS failure surfaces as an
    // unrelated resolution error, so there is nothing recognisable to translate
    // afterwards.
    if (entryIsCommonJs(file)) throw commonJsEntryError(file);

    const tsx = await tryImportTsxApi(file);
    if (tsx) {
      const unregister = tsx.register();
      try {
        return (await import(url)) as Record<string, unknown>;
      } catch (err) {
        // V8 formats `.stack` on first read, and only while tsx is registered
        // are source maps on — read after `unregister()` it names the
        // transpiled position (line 1), not the author's line.
        if (err instanceof Error) void err.stack;
        throw noProjectEntryError(file, err) ?? err;
      } finally {
        unregister();
      }
    }
  }

  try {
    // Either a plain `.js`/`.mjs` entry, or a `.ts` entry with no tsx available
    // — in which case native type stripping is the only chance we have.
    return (await import(url)) as Record<string, unknown>;
  } catch (err) {
    const noProject = noProjectEntryError(file, err);
    if (noProject !== undefined) throw noProject;
    if (!isTypeScript) throw err;
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // tsx would have recovered these two, and it isn't installed. Chain the
    // original loader failure so a genuine (non-loader) error in the user's
    // module isn't masked by the "install tsx" message.
    //   • ERR_UNKNOWN_FILE_EXTENSION — older Node with no native `.ts` support.
    //   • ERR_MODULE_NOT_FOUND — the unremapped `.js` specifier described above.
    if (code === "ERR_UNKNOWN_FILE_EXTENSION" || code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(`Loading a TypeScript entry ("${file}") requires \`tsx\`. ${await tsxRemedy(file)}`, { cause: err });
    }
    if (err instanceof SyntaxError && /import statement outside a module/.test(err.message)) {
      throw commonJsEntryError(file, err);
    }
    throw err;
  }
}

/** The resolved version, kept for the life of the process. See {@link readVersion}. */
let cachedVersion: string | undefined;

/**
 * Resolve this package's version for `xanosdk version`. Walks up from the running
 * module to the package root's `package.json` (`dist/cli.js` → `../`, the
 * `src/emit/cli.ts` source → `../../`), matching on the package NAME so a stray
 * ancestor `package.json` can't shadow it. Best-effort: returns `"unknown"` rather
 * than throwing when it can't be located, since a version print must never fail.
 *
 * MEMOIZED, because this stopped being a once-per-command question. The version
 * is read by the update notice, by the scaffold's templates, by the bundle
 * and preflight hooks, and by the toolchain loader's peer-range check — several
 * of them in the same run — and the answer cannot change while the process
 * lives: it is this installation's own manifest. Without the cache a single
 * `deploy` walks up to six directories, reading and parsing at each, more than
 * once for a fact it already had. `"unknown"` is cached too; a version that
 * could not be located once will not be located a moment later, and re-walking
 * on every call is precisely the cost this removes.
 */
export function readVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  cachedVersion = resolveVersion();
  return cachedVersion;
}

function resolveVersion(): string {
  return ownPackage()?.version ?? "unknown";
}

/**
 * This installation's own package root and version: walks up from the running
 * module (`dist/cli.js` → `../`, `src/emit/cli.ts` → `../../`), matching on the
 * package NAME so a stray ancestor `package.json` cannot shadow it.
 */
function ownPackage(): { root: string; version: string } | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(dir, "package.json");
    if (existsSync(p)) {
      try {
        const pkg = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "@xano/sdk" && typeof pkg.version === "string") return { root: dir, version: pkg.version };
      } catch {
        /* unreadable or not JSON — keep walking up */
      }
    }
    const up = dirname(dir);
    if (up === dir) break; // reached the filesystem root
    dir = up;
  }
  return undefined;
}

/**
 * The `emit` of the `@xano/sdk` copy the ENTRY resolves, when that is not
 * this CLI's own copy.
 *
 * A def is built by the SDK its module imports, and its statements are
 * registered in THAT copy's statement registry. A global or repo-checkout
 * `xanosdk` compiling a project with its own install is two copies: encoding
 * the project's def with this CLI's `emit` looks every statement up in a
 * registry that never saw them. `export` never hits this because it calls the
 * workspace's own `export()` method; `compile` takes a lone def, which has no
 * method to call, so the project's `emit` is imported instead. The same copy
 * (or none resolvable, e.g. an entry outside any project) keeps this CLI's.
 */
export async function emitterFor(file: string): Promise<typeof emit> {
  let manifestPath: string;
  try {
    manifestPath = createRequire(pathToFileURL(resolve(file))).resolve("@xano/sdk/package.json");
  } catch {
    return emit;
  }
  const root = realpathSync(dirname(manifestPath));
  const own = ownPackage();
  if (own === undefined || root === realpathSync(own.root)) return emit;
  try {
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      main?: string;
      exports?: Record<string, { import?: string } | string>;
    };
    const dot = pkg.exports?.["."];
    const entry = (typeof dot === "string" ? dot : dot?.import) ?? pkg.main;
    if (entry === undefined) return emit;
    const mod = (await import(pathToFileURL(join(root, entry)).href)) as { emit?: unknown };
    return typeof mod.emit === "function" ? (mod.emit as typeof emit) : emit;
  } catch {
    return emit;
  }
}

/**
 * Write the grouped command reference to STDOUT — help is requested output, not
 * an error. The reference itself comes from the command registry via
 * `help.ts`; nothing about the command surface is written down here.
 */
export function printHelp(): void {
  process.stdout.write(terminalText(withCliPrefix(renderGlobalHelp(stdoutStyle(), readVersion()))));
}

/** Whether `path` is `dir` or lies somewhere under it (both absolute). */
function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The two fix-up commands for one orphan, spelled so they RUN as printed.
 *
 * Neither resolves the lock the way `export` just did. `lock rename` takes no
 * entry file at all, so it looks for `xano.lock` in the current directory —
 * which in the scaffolded layout (`xano/xano.lock`, CI at the repo root, where
 * this text prints) is the one place it is not. `lock prune` takes the entry
 * file and derives the lock from it, so it needs the entry named. A remedy a
 * reader pastes and gets an error from is worse than no remedy: it reads as the
 * tool being broken rather than as the command being incomplete.
 */
export function orphanFixUps(
  key: string,
  entryFile: string,
  lockPath: string,
  kinds?: ReadonlyMap<string, string>,
  /** Orphaned entries whose keys compose this one's name: its rename moves them, its prune drops them too. */
  children: readonly string[] = [],
  /** The one candidate for the new name, when there is exactly one: printed in place of the placeholder. */
  only?: string,
): string[] {
  // A relative path that climbs out of the working tree is noise, not a
  // shortcut — `../../../../var/folders/…` is harder to read than the absolute
  // path it spells. Only use it when it actually points inward.
  // Spelled from where the reader typed the command (E2E pass 24: from a
  // subdirectory the root-relative path named nothing there).
  const shown = displayPath(lockPath);
  const lockFlag = `--lock=${shellWord(shown)}`;
  entryFile = pastePath(entryFile);
  // The key is named, so the paste drops THIS entry and no other orphan the
  // same export reported (one of which may be the rename it is not); `--yes`
  // because prune refuses without it, and a remedy that exits 1 asking for a
  // flag is a remedy that does not run as printed.
  const shownKey = displayLockKey(key, kinds);
  const pruned = [key, ...children].map((k) => shellWord(displayLockKey(k, kinds))).join(" ");
  const prune = `xanosdk lock prune ${shellWord(entryFile)} ${pruned} ${lockFlag} --yes`;
  if (key === WORKSPACE_KEY) return [`deleted? run: ${prune}`];
  const sep = key.indexOf(":");
  const payloadKey = key.slice(0, sep);
  const name = key.slice(sep + 1);
  const kind = shownKey.slice(0, shownKey.indexOf(":"));
  // A query is locked by its composed identity, so the new name has that shape
  // too — a bare name there is accepted by nothing an export writes.
  const newName =
    only !== undefined ? shellWord(only) : payloadKey === "query" ? `'<group>|<VERB>|<name>'` : "<new-name>";
  return [
    // `--entry` too: the rename replaces the fresh entry this export appended
    // for the new name, and only the source can tell that from a live object.
    // The SDK's kind name (`table`, not the lock file's `dbo`): the reader
    // wrote `table()`, and `lock rename` accepts either spelling.
    // A placeholder makes it a template, not a command: said so, not "run:".
    `${only !== undefined ? "renamed? run:" : `if renamed, put the new ${payloadKey === "query" ? "key" : "name"} in place of ${newName} and run:`} xanosdk lock rename ${kind} ${shellWord(name)} ${newName} ${lockFlag} --entry=${shellWord(entryFile)}` +
      (children.length === 0 ? "" : ` (it moves ${describeChildren(children)} with it)`),
    `deleted? run: ${prune}`,
  ];
}

/** The kinds whose lock keys compose a parent's name: `lock rename` of the parent moves them. */
const COMPOSED_CHILDREN: Readonly<Record<string, readonly string[]>> = {
  app: ["query"],
  realtime_server: ["channel", "message"],
  channel: ["message"],
};

/** The keys among `keys` whose names compose `key`'s (an api group's queries): a `lock rename` of it moves them. */
export function composedChildren(key: string, keys: readonly string[]): string[] {
  const sep = key.indexOf(":");
  const kids = COMPOSED_CHILDREN[key.slice(0, sep)];
  if (kids === undefined) return [];
  const name = key.slice(sep + 1);
  return keys.filter((k) => kids.some((c) => k.startsWith(`${c}:${name}|`)));
}

/**
 * Each orphan whose name other orphans' keys compose (an api group and its
 * queries, a realtime server and its channels and messages), with those
 * children. A child is said under its parent only: its own `lock rename`
 * fails once the parent's has moved it (E2E pass 21).
 */
function orphanFamilies(orphans: readonly string[]): { children: Map<string, string[]>; folded: Set<string> } {
  const children = new Map<string, string[]>();
  const folded = new Set<string>();
  for (const key of orphans) {
    const sep = key.indexOf(":");
    const kids = COMPOSED_CHILDREN[key.slice(0, sep)];
    if (kids === undefined) continue;
    const name = key.slice(sep + 1);
    const mine = orphans.filter((k) => kids.some((c) => k.startsWith(`${c}:${name}|`)));
    if (mine.length === 0) continue;
    children.set(key, mine);
    for (const k of mine) folded.add(k);
  }
  return { children, folded };
}

/** `2 queries`, `1 channel and 3 messages`. */
function describeChildren(keys: readonly string[]): string {
  const noun: Record<string, [string, string]> = {
    query: ["query", "queries"],
    channel: ["channel", "channels"],
    message: ["message", "messages"],
  };
  const parts: string[] = [];
  for (const kind of ["query", "channel", "message"]) {
    const n = keys.filter((k) => k.startsWith(`${kind}:`)).length;
    if (n > 0) parts.push(`${n} ${noun[kind]![n === 1 ? 0 : 1]}`);
  }
  return `its ${parts.join(" and ")}`;
}

/**
 * Orphan warnings: a lock entry nothing matched is either a rename (the
 * fix-up command keeps the engine-side object alive) or a deletion. Warnings
 * go to STDERR only — stdout may be a piped bundle. Renames are never guessed;
 * newcomers of the same kind are listed as candidates, no more.
 */
function warnOrphans(
  orphans: string[],
  dropped: string[],
  cededCanonicals: string[],
  previous: LockFile,
  observed: Record<string, unknown>,
  entryFile: string,
  lockPath: string,
  kinds: ReadonlyMap<string, string> | undefined,
  /** This run does not write the lock (a dry run): its changes are said as what a real run would do. */
  pending: boolean,
  /** `--allow-lock-orphans` was passed: the note telling the reader to pass it is not said. */
  accepted = false,
): void {
  // Entries `lock import` adopted are neither renames nor deletions until the
  // reader says so, and a partly ported adoption leaves many: one warning each
  // (three lines apiece) buried the rest of the export (E2E pass 29). Said
  // once, as adopted, capped, with every key in `--json`. Only one this export
  // offers no new name for, and outside an api-group or server family: an
  // adopted entry a rename may explain keeps its own warning and its rename.
  const allFamilies = orphanFamilies(orphans);
  const allRenames = renameCandidatesFor(orphans, previous, observed, kinds);
  const adopted = orphans.filter(
    (k) =>
      k !== WORKSPACE_KEY &&
      previous.objects[k]?.adopted === true &&
      !allFamilies.children.has(k) &&
      !allFamilies.folded.has(k) &&
      allRenames.get(k)?.only === undefined &&
      (allRenames.get(k)?.hint ?? "") === "",
  );
  if (adopted.length > 0) {
    const shared = [
      ...new Set(adopted.flatMap((k) => {
        const only = allRenames.get(k)?.shared;
        return only === undefined ? [] : [`${displayLockKey(k, kinds).slice(0, displayLockKey(k, kinds).indexOf(":"))}:${only}`];
      })),
    ];
    warnAdoptedOrphans(adopted, entryFile, lockPath, kinds, accepted, shared);
    const skip = new Set(adopted);
    orphans = orphans.filter((k) => !skip.has(k));
  }
  const families = adopted.length === 0 ? allFamilies : orphanFamilies(orphans);
  const renames = adopted.length === 0 ? allRenames : renameCandidatesFor(orphans, previous, observed, kinds);
  // The third answer `export --check` gives, said here too (E2E pass 17): an
  // entry adopted by `lock import` for an object this project never ported is
  // neither a rename nor a deletion, and the gates have a flag for it. Under
  // the last warning, as its remedy, so `--json` carries it (E2E pass 28).
  // Not once the flag is passed: it told a run that already had it to pass it (E2E pass 23).
  const lastHead = accepted ? undefined : orphans.filter((k) => k !== WORKSPACE_KEY && !families.folded.has(k)).at(-1);
  // Orphans this export fills no new name in for are deletions unless a rename
  // explains them. Past a handful they are said as ONE warning with the prune
  // that drops them all (E2E pass 53: 290 removed queries, 290 warnings and no
  // bulk command) — the newcomers any of them may have been renamed to named
  // once there (E2E pass 54: one rename beside nine removals was ten warnings).
  // One a rename is filled in for keeps its own warning.
  const plain = orphans.filter((k) => {
    if (k === WORKSPACE_KEY || families.folded.has(k)) return false;
    const c = renames.get(k)!;
    return c.only === undefined && c.inCode === undefined && (c.hint === "" || c.candidates !== undefined);
  });
  const grouped = new Set(plain.length > ORPHANS_SAID_ONE_BY_ONE ? plain : []);
  if (grouped.size > 0) {
    warnPlainOrphans(plain, families.children, orphans, entryFile, lockPath, kinds, accepted, lastHead !== undefined && grouped.has(lastHead), renames);
  }
  for (const key of orphans) {
    if (grouped.has(key)) continue;
    if (key === WORKSPACE_KEY) {
      exportWarn(
        "lock.orphan",
        `xano.lock entry "${key}" matched nothing this export (no workspace canonical emitted).`,
        orphanFixUps(key, entryFile, lockPath, kinds),
        !accepted,
      );
      continue;
    }
    // Said under its parent, whose rename moves it.
    if (families.folded.has(key)) continue;
    const children = families.children.get(key) ?? [];
    const candidates = renames.get(key)!;
    const [rename, prune] = orphanFixUps(key, entryFile, lockPath, kinds, children, candidates.only);
    exportWarn(
      "lock.orphan",
      `xano.lock entry "${displayLockKey(key, kinds)}" ` +
        (children.length === 0 ? "" : `(and ${describeChildren(children)}: ${children.map((k) => displayLockKey(k, kinds)).join(", ")}) `) +
        `matches no exported object — if this was a rename, the next sync ` +
        `would delete+create unless the entry moves with it.`,
      [
        candidates.inCode !== undefined ? setGuidFixUp(candidates.inCode) : `${rename}${candidates.hint}`,
        prune!,
        ...(key === lastHead ? [ADOPTED_ORPHANS_NOTE] : []),
      ],
      // Accepted by `--allow-lock-orphans`: still said, never a `--strict`
      // failure — an adopted, partly ported workspace could otherwise never
      // pass the scaffold's `xano:check` (E2E pass 27).
      !accepted,
    );
  }
  // A parent's composed children (an api group's queries) are said with it,
  // as one line: a reverted group rename dropped one line per query.
  const droppedChildren = new Map(dropped.map((k) => [k, composedChildren(k, dropped)]));
  const droppedFolded = new Set([...droppedChildren.values()].flat());
  for (const key of dropped) {
    if (droppedFolded.has(key)) continue;
    const kids = droppedChildren.get(key) ?? [];
    const withKids = kids.length === 0 ? "" : ` (and ${describeChildren(kids)} with it)`;
    // Two ways a guid reappears under a live name, told apart by the live
    // key: one whose guid is its OWN name-derivation took the name back (a
    // rename reverted after `lock rename`); any other carried the guid forward
    // itself (an explicit in-code `guid`) — a rename that already kept its
    // identity, and needs no fix-up.
    const guid = previous.objects[key]?.guid;
    const liveKey =
      guid === undefined
        ? undefined
        : Object.keys(observed).find((k) => (observed[k] as { guid?: string } | undefined)?.guid === guid);
    const shownLive = liveKey === undefined ? undefined : displayLockKey(liveKey, kinds);
    const drop = pending ? "Would drop" : "Dropped";
    exportWarn(
      "lock.dropped-entry",
      liveKey !== undefined && guid !== rawDeriveGuid(liveKey)
        ? `${drop} lock entry "${displayLockKey(key, kinds)}"${withKids} — "${shownLive}" now carries its guid, so the rename ` +
            `${pending ? "keeps" : "kept"} its identity; nothing else to do.`
        : `${drop} stale lock entry "${displayLockKey(key, kinds)}"${withKids} — its identity reappeared under ` +
            `${shownLive === undefined ? "a live name" : `"${shownLive}"`} (a reverted rename).`,
    );
  }
  for (const key of cededCanonicals) {
    const shown = displayLockKey(key, kinds);
    // Its own fix-ups, not a pointer at the orphan warning: that one is not
    // said for an entry a landing pruned, or one folded under its parent.
    const children = composedChildren(key, Object.keys(previous.objects));
    const candidates = allRenames.get(key);
    const [rename, prune] = orphanFixUps(key, entryFile, lockPath, kinds, children, candidates?.only);
    exportWarn(
      "lock.ceded-canonical",
      `Lock entry "${shown}" ${pending ? "would keep its guid but cede" : "kept its guid but ceded"} its canonical to a live object that now emits it ` +
        `(an explicit in-code canonical). A rename moves the entry, so the object keeps its identity and its URL:`,
      [rename!, prune!],
    );
  }
}

/** How many orphans with no rename candidate get a warning each; past it, {@link warnPlainOrphans} says them as one. */
const ORPHANS_SAID_ONE_BY_ONE = 5;

/**
 * One warning for many orphans this export offers no new name for: capped in
 * the text (`--json` lists every key), with one rename template and the prune
 * that drops them all — bare when they are every orphan a bare prune drops,
 * else by key.
 */
function warnPlainOrphans(
  plain: readonly string[],
  children: ReadonlyMap<string, string[]>,
  orphans: readonly string[],
  entryFile: string,
  lockPath: string,
  kinds: ReadonlyMap<string, string> | undefined,
  accepted: boolean,
  carriesAdoptedNote: boolean,
  renames: ReadonlyMap<string, RenameCandidates>,
): void {
  const SHOWN = 5;
  const keys = plain.flatMap((k) => [k, ...(children.get(k) ?? [])]);
  // The newcomers any of them may have been renamed to, once per kind.
  const newcomers = new Map<string, string[]>();
  for (const k of plain) {
    const c = renames.get(k)?.candidates;
    if (c === undefined) continue;
    const names = newcomers.get(c.noun) ?? [];
    for (const n of c.names) if (!names.includes(n)) names.push(n);
    newcomers.set(c.noun, names);
  }
  const maybe = [...newcomers].map(([noun, names]) => `new ${noun} names this export: ${names.join(", ")}`).join("; ");
  const shown = keys.map((k) => displayLockKey(k, kinds));
  const list = (names: readonly string[]): string => names.map((k) => `"${k}"`).join(", ");
  const head = (names: string): string =>
    `${keys.length} xano.lock entries match no exported object, and this export ` +
    `${maybe === "" ? "has no new name for any of them" : "fills in no new name for any of them"}: ` +
    `${names}. If one was renamed, the next sync would delete+create it unless its entry moves with it.`;
  const lockFlag = `--lock=${shellWord(displayPath(lockPath))}`;
  const entry = shellWord(pastePath(entryFile));
  // A bare prune drops every orphan but the adopted ones: printed bare only
  // when that is exactly these, so it never drops an entry warned as a rename.
  const listed = new Set(keys);
  const bare = orphans.every((k) => listed.has(k));
  const prune = `xanosdk lock prune ${entry}${bare ? "" : ` ${shown.map(shellWord).join(" ")}`} ${lockFlag} --yes`;
  const remedies = [
    `if one was renamed${maybe === "" ? "" : ` (${maybe})`}, put its kind and names in place of the placeholders and run: ` +
      `xanosdk lock rename <kind> <old-name> <new-name> ${lockFlag} --entry=${entry}`,
    `deleted? drop ${bare ? "them all" : "these"}: ${prune}`,
    ...(carriesAdoptedNote && !accepted ? [ADOPTED_ORPHANS_NOTE] : []),
  ];
  const capped =
    shown.length <= SHOWN
      ? list(shown)
      : `${list(shown.slice(0, SHOWN))}, and ${shown.length - SHOWN} more (\`--json\` lists every one)`;
  exportWarn("lock.orphan", head(capped), remedies, !accepted, [head(list(shown)), ...remedies].join("\n"));
}

/**
 * The one warning for every orphan `lock import` adopted: they pin objects
 * still serving on the backend they came from, so a bare `lock prune` keeps
 * them, and one is dropped only by naming its key. Capped in the text; `--json`
 * lists every key.
 */
function warnAdoptedOrphans(
  adopted: readonly string[],
  entryFile: string,
  lockPath: string,
  kinds: ReadonlyMap<string, string> | undefined,
  accepted: boolean,
  /**
   * Newcomers of this export (`table:alpha2`) that were the lone candidate for
   * several of these orphans at once: no one's rename, so named once here.
   */
  shared: readonly string[] = [],
): void {
  const SHOWN = 5;
  const shown = adopted.map((k) => displayLockKey(k, kinds));
  const n = adopted.length;
  const one = n === 1;
  const list = (keys: readonly string[]): string => keys.map((k) => `"${k}"`).join(", ");
  const head = (keys: string): string =>
    `${n} xano.lock ${one ? "entry" : "entries"} adopted by \`lock import\` ${one ? "matches" : "match"} no exported ` +
    `object: ${keys}. ${one ? "It pins an object" : "They pin objects"} still serving on the backend ` +
    `${one ? "it was" : "they were"} adopted from — a part of it this project has not ported — so a bare ` +
    `\`xanosdk lock prune\` keeps ${one ? "it" : "them"}.`;
  const lockFlag = `--lock=${shellWord(displayPath(lockPath))}`;
  const entry = shellWord(pastePath(entryFile));
  const prune = `xanosdk lock prune ${entry} ${shellWord(shown[0]!)} ${lockFlag} --yes`;
  const renameOne = (newcomer: string): string => {
    const kind = newcomer.slice(0, newcomer.indexOf(":"));
    const name = newcomer.slice(kind.length + 1);
    const placeholder = kind === "query" ? `"<group>|<VERB>|<old-name>"` : "<old-name>";
    return (
      `"${newcomer}" is new this export and could be any one of them renamed, so it is offered to none — ` +
      `if one is: xanosdk lock rename ${kind} ${placeholder} ${shellWord(name)} ${lockFlag} --entry=${entry}`
    );
  };
  const remedies = [
    `deleted from that backend? drop it by naming its key: ${prune}` + (one ? "" : " (one key or several)"),
    ...shared.map(renameOne),
    // The per-orphan warnings' note, word for word: one answer, one sentence.
    ...(accepted ? [] : [ADOPTED_ORPHANS_NOTE]),
  ];
  const capped =
    n <= SHOWN ? list(shown) : `${list(shown.slice(0, SHOWN))}, and ${n - SHOWN} more (\`--json\` lists every one)`;
  exportWarn("lock.orphan-adopted", head(capped), remedies, !accepted, [head(list(shown)), ...remedies].join("\n"));
}

/**
 * The adopted-and-not-ported answer to an orphan, in the plain export's
 * warning — the answer the `--frozen-lock` / `export --check` refusal gives,
 * worded for a run that is not itself the gate.
 */
const ADOPTED_ORPHANS_NOTE =
  `Adopted a live workspace and ported only part of it? Those entries pin objects that are ` +
  `still serving, so pruning them would hand the engine back its own objects as strangers. ` +
  `Pass \`--allow-lock-orphans\` to \`--frozen-lock\` or \`export --check\` to accept them there.`;

/**
 * The candidates for an orphan's new name — objects of its kind this export
 * records that the lock did not have — as ` (new table names this export: …)`,
 * or "" when there are none. Renames are never guessed; they are listed — and
 * when exactly one qualifies it is `only`, which the printed rename spells in
 * place of its placeholder (the hint is then "": it would repeat the name).
 *
 * Every candidate passes {@link plausibleRename} (E2E pass 27: a lone newcomer
 * skipped it, and a GET was offered a POST's name), is a NEWCOMER — never an
 * entry the lock already holds — and is not live on a landed backend under
 * another identity. Following a wrong suggestion moves one object's guid onto
 * another.
 */
function renameCandidates(
  key: string,
  previous: LockFile,
  observed: Record<string, unknown>,
  kinds: ReadonlyMap<string, string> | undefined,
  /** Every landing record this project keeps (see `allLandings`). */
  landings: ReadonlyArray<readonly [string, Readonly<Record<string, { guid: string }>>]>,
): RenameCandidates {
  if (key === WORKSPACE_KEY) return { hint: "" };
  const payloadKey = key.slice(0, key.indexOf(":"));
  const shown = displayLockKey(key, kinds);
  const kind = shown.slice(0, shown.indexOf(":"));
  // Agents and MCP servers share the lock's `toolset` payload key, but a rename
  // never turns one into the other: only candidates of the orphan's own kind
  // are listed, so an agent is never offered as an mcpServer's new name. An
  // orphan toolset the bundle no longer carries has no known kind, so its
  // candidates are listed with their own (`agent:a, mcpServer:m`).
  const orphanName = key.slice(payloadKey.length + 1);
  const kindKnown = payloadKey !== "toolset" || kinds?.has(orphanName) === true;
  const sameKind = Object.keys(observed).filter(
    (k) =>
      k.startsWith(`${payloadKey}:`) &&
      (!kindKnown || displayLockKey(k, kinds).startsWith(`${kind}:`)) &&
      previous.objects[k]?.adopted !== true &&
      // A guid `lock import` took from a live backend stays that object's
      // after the code declares it — even one its name derives (a backend
      // deployed from code): offered, the printed rename replaced it (E2E pass 30).
      previous.objects[k]?.imported !== true,
  );
  const label = (k: string): string => (kindKnown ? k.slice(payloadKey.length + 1) : displayLockKey(k, kinds));
  const noun = kindKnown ? kind : "agent/mcpServer";
  const single = (names: readonly string[]): { hint: string; only: string } | undefined =>
    names.length === 1 && kindKnown ? { hint: "", only: names[0]! } : undefined;
  // Of several, only the ones whose NAME is near too; a lone one stands on its
  // kind (and, for a query, its route) alone — it is the only one there is.
  const nameOf = (k: string): string => k.slice(payloadKey.length + 1);
  const narrowed = (keys: readonly string[]): string[] => {
    const routed = keys.filter((k) => plausibleRename(orphanName, nameOf(k), false));
    return routed.length === 1 ? routed : routed.filter((k) => plausibleRename(orphanName, nameOf(k), true));
  };
  // Never a name a landing record holds under another identity — the lock's
  // records, an ephemeral's, a Xano Engine's: it is live there as an object
  // of its own, so moving the orphan's identity onto it wedges that backend's
  // next deploy. A `pull release:` drops such an entry from `objects` and keeps
  // its landing, so it reads as a newcomer too (E2E pass 28: `list_tags`,
  // offered and followed, refused with SDK_IDENTITY_CONFLICT). One that landed
  // BESIDE the orphan was live at the same time as it, so it is another object.
  const orphanGuid = previous.objects[key]?.guid;
  const landed = (k: string): boolean =>
    landings.some(([, record]) => record[k] !== undefined && (key in record || record[k]!.guid !== orphanGuid));
  const newcomers = likeliestFirst(
    orphanName,
    narrowed(sameKind.filter((k) => !(k in previous.objects) && !landed(k))),
    payloadKey,
  ).map(label);
  // A lone query in the same group and verb is filled in only when its name is
  // near or shares a word (`add_note` → `create_note`); otherwise it is listed
  // (E2E pass 37 filled `backfill` → `add_shipment`).
  const guessable = (name: string): boolean =>
    orphanName.split("|").length !== 3 || plausibleRename(orphanName, name, true) || sharesWord(orphanName, name);
  if (newcomers.length > 0) {
    const lone = newcomers.length === 1 && guessable(newcomers[0]!) ? single(newcomers) : undefined;
    // A newcomer whose def pins its own guid takes no lock entry: the next
    // export replaces whatever `lock rename` moved onto it with the def's guid.
    const seen = lone === undefined ? undefined : (observed[`${payloadKey}:${lone.only}`] as LockEntry | true | undefined);
    const pinned = typeof seen === "object" ? seen.guid : undefined;
    const inCode = typeof seen === "object" && seen.guid_source === "code";
    if (
      lone !== undefined &&
      orphanGuid !== undefined &&
      typeof pinned === "string" &&
      pinned !== orphanGuid &&
      (inCode || pinned !== rawDeriveGuid(`${payloadKey}:${lone.only}`))
    ) {
      return { hint: "", inCode: { name: lone.only, guid: orphanGuid, pins: pinned } };
    }
    return lone ?? { hint: ` (new ${noun} names this export: ${newcomers.join(", ")})`, candidates: { noun, names: newcomers } };
  }
  // An entry an earlier export wrote for a def that pins its own guid: no
  // `lock rename` can reach it, so a lone near one is offered the def's
  // `guid:` — what the merge refusal for the same drop says (E2E pass 41: the
  // warning printed a `lock rename`, the refusal right after it said "not a
  // lock rename"). One that landed beside the orphan is another object.
  const codePinnedHere = narrowed(
    sameKind.filter((k) => {
      const e = previous.objects[k];
      return e?.guid_source === "code" && e.guid !== orphanGuid && !landed(k);
    }),
  ).map(label);
  if (orphanGuid !== undefined && codePinnedHere.length === 1 && kindKnown && guessable(codePinnedHere[0]!)) {
    const pins = previous.objects[`${payloadKey}:${codePinnedHere[0]!}`]!.guid!;
    return { hint: "", inCode: { name: codePinnedHere[0]!, guid: orphanGuid, pins } };
  }
  // Never an entry the lock already holds. Once a bare export has written the
  // renamed object's entry, nothing tells it from an object that sat beside the
  // orphan all along — and a rename onto one of those moves the orphan's guid
  // over that object's own identity (E2E pass 32: a deleted table's rename was
  // filled in with an unrelated table, and following it re-keyed that table).
  // The rename keeps its placeholder; the reader names the new object.
  return { hint: "" };
}

/** Whether two route names' last segments share a word of three letters or more (`add_note`, `create_note`). */
function sharesWord(a: string, b: string): boolean {
  const words = (n: string): string[] =>
    (n.split("|").at(-1) ?? "")
      .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length >= 3);
  const mine = new Set(words(a));
  return words(b).some((w) => mine.has(w));
}

/**
 * Whether `name` could be `orphanName` renamed. A query is locked by its
 * route (`group|VERB|name`): a rename keeps its group and changes its verb or
 * its name, never both (E2E pass 27 offered `GET list_tags` the name
 * `POST create_note`). With `near`, the name must also be within half its
 * length of the orphan's (E2E pass 26: every unrelated query was offered).
 */
function plausibleRename(orphanName: string, name: string, near: boolean): boolean {
  const split = (n: string): string[] => (n.split("|").length === 3 ? n.split("|") : ["", "", n]);
  const [og, ov, on] = split(orphanName);
  const [g, v, n] = split(name);
  if (g !== og || (v !== ov && n !== on)) return false;
  return !near || editDistance(on!, n!) <= Math.max(3, Math.ceil(on!.length / 2));
}

/**
 * {@link renameCandidates} for every orphan of one run. A new name filled in
 * for two orphans at once is a guess between them — following it for the
 * wrong one moves that object's guid onto the other — so it is listed under
 * each instead, and the reader picks.
 */
/** An orphan's likely new name, as {@link renameCandidates} reads it. */
interface RenameCandidates {
  hint: string;
  /** The one candidate, filled into the printed `lock rename`. */
  only?: string;
  /** The one candidate, shared with other orphans (an adopted one's). */
  shared?: string;
  /** The newcomers {@link hint} names when it names more than one, or one no rename is filled in for. */
  candidates?: { noun: string; names: readonly string[] };
  /**
   * The one candidate pins its own guid in its def: no `lock rename` carries
   * the identity onto it, so the def is pointed at the orphan's `guid` instead.
   */
  inCode?: { name: string; guid: string; pins: string };
}

/** The rename fix-up for {@link RenameCandidates.inCode}: set the def's guid, not the lock's. */
export function setGuidFixUp(inCode: NonNullable<RenameCandidates["inCode"]>): string {
  return (
    `renamed to "${inCode.name}"? set its def to \`guid: "${inCode.guid}"\` — its def pins its own guid ` +
    `(${inCode.pins}), which replaces any lock entry, so a \`lock rename\` cannot carry the identity`
  );
}

export function renameCandidatesFor(
  orphans: readonly string[],
  previous: LockFile,
  observed: Record<string, unknown>,
  kinds?: ReadonlyMap<string, string>,
): Map<string, RenameCandidates> {
  const landings = allLandings(process.cwd(), previous);
  const all = new Map<string, RenameCandidates>(
    orphans.map((key) => [key, renameCandidates(key, previous, observed, kinds, landings)] as const),
  );
  const target = (key: string, only: string): string => `${key.slice(0, key.indexOf(":"))}:${only}`;
  const filled = new Map<string, number>();
  for (const [key, c] of all) {
    if (c.only !== undefined) filled.set(target(key, c.only), (filled.get(target(key, c.only)) ?? 0) + 1);
  }
  for (const [key, c] of all) {
    if (c.only === undefined || filled.get(target(key, c.only))! < 2) continue;
    // An adopted orphan's lone newcomer shared with others is no candidate for
    // any one of them (E2E pass 30: one newcomer, six adopted orphans, six
    // warnings): not offered, so they stay in the grouped warning — which
    // names the newcomer once, as `shared`.
    if (previous.objects[key]?.adopted === true) {
      all.set(key, { hint: "", shared: c.only });
      continue;
    }
    const shown = displayLockKey(key, kinds);
    all.set(key, {
      hint: ` (its new name may be ${c.only} — the one candidate for another orphan too, so run the rename only for the entry that was renamed)`,
      candidates: { noun: shown.slice(0, shown.indexOf(":")), names: [c.only] },
    });
  }
  return all;
}

/**
 * Lock keys ordered by how likely each is an orphan's new name, so the capped
 * list shows the rename first: for a query, the same api group and verb before
 * anything else (`group|VERB|name`), then the name nearest by edit distance.
 * Ties keep the export's order.
 */
function likeliestFirst(orphanName: string, keys: readonly string[], payloadKey: string): string[] {
  const parts = (name: string): string[] => name.split("|");
  const [og, ov, on] = parts(orphanName).length === 3 ? parts(orphanName) : ["", "", orphanName];
  const score = (key: string): number => {
    const name = key.slice(payloadKey.length + 1);
    const [g, v, n] = parts(name).length === 3 ? parts(name) : ["", "", name];
    return (g === og ? 0 : 2000) + (v === ov ? 0 : 1000) + editDistance(on!, n!);
  };
  return keys
    .map((key, i) => ({ key, i, s: score(key) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((e) => e.key);
}

/** Levenshtein distance — small strings only (object names). */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * The code every "a committed artifact is out of date" refusal carries —
 * `export --check` / `--frozen-lock` over the lock, `routes --strict` over the
 * route manifest — so CI branches on one code for all of them.
 */
const DRIFT = "SDK_DRIFT";

/** Where a lock-only export sends the bundle it has no use for. */
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * The `--frozen-lock` / `export --check` refusal for an export that would
 * change the lock.
 *
 * It names what would change, key by key — "the lock would change" alone sends
 * the reader off to diff a file this run never wrote. The minted-canonical
 * warning is said only when a canonical really would be minted: a query that
 * gains a guid discards nothing. And the remedy is one that runs where the
 * reader is: a plain export of a source that gates published docs needs those
 * tokens, so they are named with the ways to supply them.
 */
function frozenChangeMessage(
  gate: string,
  before: LockFile | undefined,
  after: LockFile,
  file: string,
  lockPath: string,
  def: Xano,
  args: ParsedArgs,
  kinds?: ReadonlyMap<string, string>,
  droppedLandings: readonly string[] = [],
): string {
  const was = before?.objects ?? {};
  const added: string[] = [];
  const changed: string[] = [];
  const removed = Object.keys(was).filter((k) => !(k in after.objects));
  let minted = false;
  for (const [key, entry] of Object.entries(after.objects)) {
    const prior = was[key];
    if (prior === undefined) added.push(key);
    else if (JSON.stringify(prior) !== JSON.stringify(entry)) changed.push(key);
    // Only a canonical this run MINTED is lost when the write is refused
    // (`canonical_source: "minted"`). One the code pins (`"code"`, e.g.
    // `registerAuth(..., { canonical: "authn" })`) is re-derived from the source
    // on every run, and the workspace's own slug is never minted at all (it is
    // recorded unclassified — the instance provisions it).
    if (entry.canonical !== undefined && entry.canonical !== prior?.canonical && entry.canonical_source === "minted") {
      minted = true;
    }
  }
  const SHOWN = 5;
  const list = (label: string, keys: string[]): string[] =>
    keys.length === 0
      ? []
      : [
          `  ${label}: ${keys.slice(0, SHOWN).map((k) => JSON.stringify(displayLockKey(k, kinds))).join(", ")}` +
            (keys.length > SHOWN ? `, and ${keys.length - SHOWN} more` : ""),
        ];
  // Only the gates a plain export HERE could not supply: one whose token is
  // already in the secrets file (or passed with `--doc-token`) needs nothing,
  // and saying it does sends the reader to fix what is not broken.
  const have = availableDocTokenKeys(args, file);
  const gates = def
    .documentationTokenNames()
    .filter(
      (d) =>
        d.gated &&
        d.published &&
        !have.has(d.key) &&
        !Object.hasOwn(args.docTokens, documentationScopeFlagLabel(d.scope)),
    );
  const one = gates.length === 1;
  const tokens =
    gates.length === 0
      ? ""
      : ` It needs the documentation token${one ? "" : "s"} this source gates ` +
        // No `xanosdk pull`: every gate listed is declared in THIS source, and a
        // pull replaces the source with the target's — an authored
        // `require_token: true` read back as whatever the target holds.
        `(${safeNames(gates.map((d) => documentationScopeLabel(d.scope)))}): \`${secretsRemedyFor(file).fill}\` mints ` +
        `${one ? "one" : "them"} into \`${secretsRemedyFor(file).file}\`, or pass ` +
        `${gates.map((d) => `\`--doc-token "${documentationScopeFlagLabel(d.scope)}=<value>"\``).join(" ")}.`;
  const head =
    before !== undefined
      ? `${gate}: this export would change ${displayPath(lockPath)}${fileSpellingNote([...added, ...changed, ...removed])}:`
      : `${gate}: no xano.lock found at ${displayPath(lockPath)}, and this source has identities to record:`;
  return [
    head,
    ...list("add", added),
    ...list("change", changed),
    ...list("remove", removed),
    ...(droppedLandings.length === 0
      ? []
      : [
          `  drop: ${droppedLandings.length === 1 ? "an ephemeral's landing record" : `${droppedLandings.length} ephemeral landing records`} ` +
            `(${droppedLandings.slice(0, SHOWN).map((d) => JSON.stringify(d)).join(", ")}` +
            `${droppedLandings.length > SHOWN ? `, and ${droppedLandings.length - SHOWN} more` : ""}) — ` +
            `an ephemeral's record now lives in \`.xano/ephemeral.json\`, not the lock`,
        ]),
    // `--out` to the null device: a bare export writes the whole bundle — env
    // values and documentation tokens in cleartext — to the terminal, when all
    // the reader needs from it is the lock it records.
    `Run \`xanosdk export ${shellWord(file)} --out ${NULL_DEVICE}\` locally — it records the lock and writes ` +
      `the bundle nowhere — commit the ${before !== undefined ? "updated " : ""}xano.lock it writes, and retry.${tokens}` +
      (before === undefined && args.check
        ? ` Until then, \`--check --no-lock\` checks everything but the lock.`
        : "") +
      (minted
        ? ` A canonical minted here would be discarded, permanently diverging public URLs.`
        : ""),
  ].join("\n");
}

/**
 * The `--frozen-lock` refusal for a lock that carries orphans.
 *
 * The "would this export change the lock" gate catches a rename only while the
 * lock has not yet absorbed it — and a bare `xanosdk export` absorbs it at once,
 * writing the orphaned old entry and the freshly minted new one together. From
 * then on the lock is stable, so the change-keyed gate passes a rename that is
 * about to delete-and-create a live object. The orphan is the signal
 * that survives that round-trip, so the orphan is what is gated here.
 *
 * Deliberately NOT narrowed to renames. Once the bare export has written both
 * entries, nothing distinguishes a rename from a deletion — and the two differ
 * by whether live data survives the next sync. CI declines to guess; the author
 * declares intent with one of the two commands named below, both of which
 * leave a lock that passes.
 */
function frozenOrphanError(
  orphans: readonly string[],
  entryFile: string,
  lockPath: string,
  gate: string,
  context: { previous: LockFile; observed: Record<string, unknown>; kinds?: ReadonlyMap<string, string> },
): Error {
  const { previous, observed, kinds } = context;
  const where = displayPath(lockPath);
  const many = orphans.length !== 1;
  // A wholesale rename sweep can orphan dozens at once. The per-entry fix-ups
  // are the useful part of this message, and thirty of them is a wall nobody
  // reads — so the listing is capped and the remainder is counted.
  const SHOWN = 5;
  // An orphaned group's queries (a server's channels and messages) are said
  // under it, as the plain export's warning says them: its rename moves them
  // and its prune drops them, while their own fix-ups fail once it has
  // (E2E pass 22). The count stays every entry.
  const families = orphanFamilies(orphans);
  const heads = orphans.filter((k) => !families.folded.has(k));
  const shown = heads.slice(0, SHOWN);
  const rest = heads.length - shown.length;
  const named = (k: string): string => {
    const children = families.children.get(k) ?? [];
    return `${JSON.stringify(displayLockKey(k, kinds))}${children.length === 0 ? "" : ` (and ${describeChildren(children)})`}`;
  };
  const lines = [
    `${gate}: ${where} carries ${orphans.length} ` +
      `${many ? "entries that match" : "entry that matches"} no exported object: ` +
      `${shown.map(named).join(", ")}${rest > 0 ? `, and ${rest} more` : ""}.`,
    `A rename done in code lands here — the old name's entry stays behind while the new name ` +
      `mints a fresh identity, so the next sync DELETES the object and creates another in its ` +
      `place. A deletion lands here too, and once a plain \`xanosdk export\` has written the lock ` +
      `nothing tells the two apart, so the intent has to be declared rather than guessed.`,
  ];
  const renames = renameCandidatesFor(heads, previous, observed, kinds);
  // Every orphan's fix-ups, the capped ones too: `--json` carries them all
  // under `details.orphans` (E2E pass 28: the sixth was reachable nowhere).
  const fixUps = heads.map((key) => {
    const candidates = renames.get(key)!;
    const children = families.children.get(key) ?? [];
    const [first, ...others] = orphanFixUps(key, entryFile, lockPath, kinds, children, candidates.only);
    // The rename fix-up carries the same candidate list the plain export's
    // warning does, so CI names the likely new name too.
    const hint = others.length > 0 ? candidates.hint : "";
    return {
      key: displayLockKey(key, kinds),
      ...(children.length === 0 ? {} : { children: children.map((k) => displayLockKey(k, kinds)) }),
      remedies: [candidates.inCode !== undefined ? setGuidFixUp(candidates.inCode) : `${first}${hint}`, ...others],
    };
  });
  for (const { key, remedies } of fixUps.slice(0, SHOWN)) for (const fix of remedies) lines.push(`  "${key}" ${fix}`);
  // Past the cap, the one prune that drops every entry this export offers no
  // new name for, as the plain export's warning gives it: bare when that is
  // every orphan a bare prune drops, else by key — so it never drops an entry
  // a rename may explain, nor one `lock import` adopted.
  let pruneAll: string | undefined;
  if (rest > 0) {
    lines.push(
      `  …and ${rest} more (${heads.slice(SHOWN).map(named).join(", ")}), each fixed the same two ways — ` +
        `\`--json\` lists every entry's commands under \`error.details.orphans\`.`,
    );
    const plain = heads.filter((k) => {
      const c = renames.get(k)!;
      return k !== WORKSPACE_KEY && previous.objects[k]?.adopted !== true && c.only === undefined && c.inCode === undefined && c.hint === "";
    });
    if (plain.length > 1) {
      const keys = plain.flatMap((k) => [k, ...(families.children.get(k) ?? [])]);
      const listed = new Set(keys);
      const bare = orphans.every((k) => listed.has(k));
      pruneAll =
        `xanosdk lock prune ${shellWord(pastePath(entryFile))}` +
        `${bare ? "" : ` ${keys.map((k) => shellWord(displayLockKey(k, kinds))).join(" ")}`} ` +
        `--lock=${shellWord(displayPath(lockPath))} --yes`;
      lines.push(`  Deleted ${bare ? "them all" : `the ${plain.length} with no new name`}? Drop ${bare ? "every one" : "those"} at once: ${pruneAll}`);
    }
  }
  lines.push(
    `Adopted a live workspace and ported only part of it? Those entries pin objects that are ` +
      `still serving, so pruning them would hand the engine back its own objects as strangers. ` +
      `Pass \`--allow-lock-orphans\` to accept them and keep the rest of this check.`,
  );
  lines.push(`Then commit the updated ${basename(lockPath)} and retry.`);
  return new CliError(DRIFT, lines.join("\n"), { details: { orphans: fixUps, ...(pruneAll === undefined ? {} : { pruneAll }) } });
}

export function run(argv: string[]): Promise<void> {
  // One JSON document per run: the failure renderer reads whether THIS run
  // already wrote one, so another run in the same process — earlier or
  // concurrent — must not count.
  // The hint context is this run's alone too: forgotten when it ends, so a
  // later run in the same process never prints another's `--config`.
  // The credential it acts as is its own too, so a refusal never names another run's.
  return inJsonDocumentScope(() =>
    inCredentialScope(() => {
      setRunFailureExplainer(explainRunCredential);
      return dispatch(argv)
        .catch(async (err: unknown) => {
          await refineGonePullHint(err);
          throw await explainRunCredential(await nameLookupRerun(unresolvableEnvInstance(err)));
        })
        .catch((err: unknown) => {
          throw carryRunWarnings(maskAssignments(err, argv));
        });
    }),
  ).finally(() => {
    setHintContext(undefined);
    noteRunScope(undefined);
    runArgs = undefined;
    noteRunArgs(undefined);
    offeredPull = undefined;
    mergeExcusedEnv = undefined;
    mergeExcusedDocToken = undefined;
  });
}

/** `NAME=value` typed as its own word: an env var assignment that lost its flag, or never had one. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/s;

/**
 * Every `NAME=value` word on the command line, shown as `NAME=…` in a refusal.
 *
 * `deploy STRIPE=sk_live_…` is a positional, and the refusal quoted it whole —
 * `Cannot find entry file "STRIPE=sk_live_…"`, `No release named …` — in every
 * command that reads its first positional as a path or a name. The value is
 * the one part that may be a secret, and nothing a refusal says needs it. Where
 * the command takes `--env-var`, the flag the reader most likely meant is named.
 */
export function maskAssignments(err: unknown, argv: readonly string[]): unknown {
  if (!(err instanceof Error)) return err;
  const words = [...new Set(argv.filter((a) => !a.startsWith("-") && ASSIGNMENT.test(a)))];
  if (words.length === 0) return err;
  const masked = (text: string): string =>
    words.reduce((t, w) => t.split(w).join(`${ASSIGNMENT.exec(w)![1]}=…`), text);
  err.message = masked(err.message);
  const suggestion = (err as { suggestion?: unknown }).suggestion;
  if (typeof suggestion === "string") Object.defineProperty(err, "suggestion", { value: masked(suggestion) });
  // A parse refusal (`deploy ./xano/index.ts SECRET=x`: one positional too
  // many) throws before `runArgs` is set, so the command and its positionals
  // are read off the argv — a word a value-taking flag consumed is not one.
  const args = runArgs ?? positionalsOf(argv);
  const positional = args?.positionals.find((p) => ASSIGNMENT.test(p));
  if (args !== undefined && positional !== undefined && flagRefFor(args.command, args.subcommand, "env-var") !== undefined) {
    const name = ASSIGNMENT.exec(positional)![1]!;
    err.message += `\n  Did you mean \`--env-var ${name}=…\`? A backend env var is set with the flag, not as an argument.`;
  }
  return err;
}

/** The command, verb and positionals of an argv the parser refused — enough to name `--env-var`. */
function positionalsOf(
  argv: readonly string[],
): { command: string | undefined; subcommand: string | undefined; positionals: string[] } | undefined {
  const [command, ...rest] = argv;
  if (command === undefined || !isCommand(command)) return undefined;
  const subcommand = NOUN_COMMANDS.has(command) ? rest.shift() : undefined;
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (SEPARATED_VALUE_SPELLINGS.has(a)) i += 1;
    else if (!a.startsWith("-")) positionals.push(a);
  }
  return { command, subcommand, positionals };
}

/**
 * A failure's `--json` document carries the run's warnings too, as
 * `error.details.warnings` — where `publish` already put its own. An export's
 * failed checks arrive as a list (`DiagnosticError`); the document names it
 * `details.diagnostics`, so the warnings have an object to sit in beside it —
 * a `--strict` refusal otherwise dropped every warning the run had printed.
 * A failure whose details are some other non-object is left as it is.
 */
export function carryRunWarnings(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const own = err as Error & { code?: unknown; details?: unknown };
  const coded = typeof own.code === "string" && own.code.startsWith("SDK_");
  if (coded && Array.isArray(own.details)) {
    // A strict refusal: every finding that fails --strict is a diagnostic,
    // whichever check threw first.
    const pending = own.code === "SDK_EXPORT_INVALID" ? takePendingStrictFindings() : [];
    const listed = own.details as Array<{ code?: unknown; message?: unknown }>;
    const joining = pending.filter((p) => !listed.some((d) => d.code === p.code && d.message === p.message));
    // `warnings` is always present beside `diagnostics`, empty when the run printed none.
    own.details = { diagnostics: [...listed, ...joining], warnings: [] };
  }
  // What an allow accepted rides beside them, exactly as the warnings do.
  let details = coded ? own.details : undefined;
  if (details !== undefined && (typeof details !== "object" || details === null || Array.isArray(details))) return err;
  for (const [key, extra] of [["warnings", runWarnings()], ["accepted", runAccepted()]] as const) {
    if (extra.length === 0) continue;
    const merged = mergeJsonWarnings((details as Record<string, unknown> | undefined)?.[key], extra);
    if (merged === undefined) continue;
    if (!coded) own.code = failureCode(err);
    details = { ...(details as Record<string, unknown> | undefined), [key]: merged };
    own.details = details;
  }
  return err;
}

/** This run's parsed arguments, for a remedy composed after the command threw. */
let runArgs: ParsedArgs | undefined;

/** What the CLI adds to any failure about the credential the run acts as. */
async function explainRunCredential(err: unknown): Promise<unknown> {
  return explainRejectedCredential(await explainUnreachableWorkspace(err));
}

/** One workspace-list read per run, shared by every failure explained in it. */
const unreachableVerdicts = new WeakMap<object, Promise<UsageError | undefined>>();

/**
 * A failure in a run whose pinned workspace answered 404 or 500, where that id
 * is not one the credential can see: every route under it fails — as "Invalid
 * workspace", a bare 404, a server error, or "No tenant named …" — and none of
 * those name the setting to fix. Said once, as the usage error `workspace
 * details` gives, with the ids that would work. A list that holds the id,
 * holds nothing, or cannot be read leaves the failure as it was, so a real
 * "not found" in a reachable workspace keeps its own answer.
 */
async function explainUnreachableWorkspace(err: unknown): Promise<unknown> {
  const resolved = lastResolvedAuth();
  if (!(err instanceof Error) || err instanceof UsageError || resolved === undefined || !pinnedWorkspaceMissed()) return err;
  const { auth } = resolved;
  let verdict = unreachableVerdicts.get(auth);
  if (verdict === undefined) {
    verdict = (async () => {
      const { readReachableWorkspaces, unreachableWorkspaceMessage } = await import("./workspace-binding.js");
      const all = await readReachableWorkspaces(auth, 15_000);
      if (all === undefined || all.length === 0 || all.some((w) => w.id === auth.workspaceId)) return undefined;
      return new UsageError(unreachableWorkspaceMessage(auth, all));
    })();
    unreachableVerdicts.set(auth, verdict);
  }
  return (await verdict) ?? err;
}

/**
 * A 401 from the instance, with the fix for the credential this run acts as.
 * A bare `get ephemeral failed (401 Unauthorized): Invalid token.`
 * named neither which credential was refused nor what replaces it, on every
 * command but `status`; this is `status`'s own remedy, said once for all of
 * them. Never the token: the remedy names where it came from, not its value.
 * The failure is coded `SDK_CREDENTIAL_REJECTED` with the same facts in
 * `details`, so a caller branches without matching the prose. A message that
 * already says a credential was rejected is left as it is — `whoami` and a
 * refused refresh code their own — and so is a failure with an `SDK_*` code.
 */
async function explainRejectedCredential(err: unknown): Promise<unknown> {
  const resolved = lastResolvedAuth();
  if (!(err instanceof Error) || resolved === undefined) return err;
  const [first = "", ...rest] = err.message.split("\n");
  if (!/\(401\b[^)]*\)|\banswered (HTTP )?401\b/.test(first) || /\brejected\b/.test(err.message)) return err;
  const { asRejectedCredential, rejectedRemedy } = await import("./whoami-command.js");
  // The arguments the credential was resolved from — its `--config`, its profile.
  const { auth, args } = resolved;
  err.message = [first, rejectedRemedy(auth, args), ...rest].join("\n");
  if (failureCode(err) === "SDK_ERROR") asRejectedCredential(err, auth, args);
  return err;
}

/**
 * A request whose host does not resolve (ENOTFOUND) under an environment
 * credential: `XANO_INSTANCE_URL` names a host that is not there, and the read's
 * "Nothing was changed — retry." would retry the same typo forever. A usage
 * failure naming the variable, as `profile add` names `--instance`.
 */
function unresolvableEnvInstance(err: unknown): unknown {
  const resolved = lastResolvedAuth();
  const url = readEnvVar("XANO_INSTANCE_URL");
  if (!(err instanceof Error) || resolved === undefined || resolved.auth.profile !== undefined || url === undefined) return err;
  let code: unknown;
  for (let e: unknown = err, depth = 0; e !== undefined && e !== null && depth < 5 && typeof code !== "string"; depth++) {
    code = (e as { code?: unknown }).code;
    e = (e as { cause?: unknown }).cause;
  }
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return err;
  }
  if (code !== "ENOTFOUND" || !err.message.includes(host) || / redirected to /.test(err.message)) return err;
  return new UsageError(
    `The host of XANO_INSTANCE_URL (${url}) does not resolve (ENOTFOUND), so nothing was sent. Check the ` +
      `variable — it is your instance's origin, e.g. https://x8ki-letl-twmt.n7.xano.io.`,
  );
}

/**
 * `env set NAME VALUE` with VALUE removed from the command line by the
 * position the parser read it at — never by searching for the value, which
 * found an equal `-p`/`--to` value (or the name) first and reprinted the
 * secret. A value piped on stdin was never on it. Exported for the tests.
 */
export function withoutSecretValue(args: ParsedArgs): ParsedArgs {
  const at = args.positionalArgv?.[1];
  if (args.argv === undefined || at === undefined) return args;
  return {
    ...args,
    argv: args.argv.filter((_, i) => i !== at),
    positionals: args.positionals.filter((_, i) => i !== 1),
    positionalArgv: args.positionalArgv!.filter((_, i) => i !== 1).map((i) => (i > at ? i - 1 : i)),
  };
}

/**
 * A backend lookup that got no answer (exit 8), or a request the instance's
 * rate limit turned away, names THIS command line as the rerun — `publish dist --to ephemeral:x`, `pull ephemeral:x`, … — built from
 * argv as deploy's retries are: this run's credential flags, and no secret
 * value reprinted (the flags it withheld are named instead).
 */
async function nameLookupRerun(failure: unknown): Promise<unknown> {
  if (!(failure instanceof Error) || runArgs?.argv === undefined) return failure;
  const { LookupFailedError, rateLimitedFailure } = await import("./source-resolve.js");
  // A write the rate limit turned away is no answer yet, as a read's is.
  const err = rateLimitedFailure(failure);
  if (!(err instanceof LookupFailedError)) return err;
  const { retryCommand, withheldNote } = await import("./deploy-command.js");
  // `env set NAME VALUE`: the value is a secret on the command line itself —
  // left out, and named, as a secret flag's is.
  if (runArgs.command === "env" && runArgs.subcommand === "set") {
    const retry = retryCommand(withoutSecretValue(runArgs));
    return err.withRerun(
      retry.command,
      "",
      ` It leaves out the value of \`${runArgs.positionals[0] ?? "NAME"}\`: it is not reprinted, so pass it again ` +
        `(or pipe it on stdin).${withheldNote(retry.withheld)}`,
    );
  }
  const retry = retryCommand(runArgs);
  // `profile add` reads its token from stdin or a hidden prompt, never argv.
  const token = runArgs.command === "profile" && runArgs.subcommand === "add" ? " with the token on stdin" : "";
  return err.withRerun(retry.command, token, withheldNote(retry.withheld));
}

/**
 * Global flags written in front of the command (`xanosdk -p prod whoami`,
 * `xanosdk --json status`), moved behind it.
 *
 * The first token is the command everywhere downstream — dispatch, help
 * resolution, the noun/verb peel in `parseArgs` — so a global flag there read as
 * `Unknown command "--json"` although help lists it as global. Moving it to the
 * END keeps the verb in the slot the peel reads, and the parse loop then treats
 * it exactly as if it had been typed last, scoped refusals included.
 *
 * Only the flags in `GLOBAL_FLAGS` that are parsed in the loop move. `--help`
 * and `--version` in front are already answered: help from the raw argv, and a
 * leading `--version` IS the version command.
 */
function hoistLeadingGlobalFlags(argv: readonly string[]): { argv: string[]; command: string[] } {
  const lead: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = expandShortAttached(argv[i]!);
    if (arg === "--json" || arg === "--no-refresh" || arg.startsWith("--profile=")) {
      lead.push(arg);
      i += 1;
    } else if (arg === "--profile" || arg === "-p") {
      // The value moves with it. A missing one is left for the loop to refuse,
      // which says what the flag needs.
      const value = argv[i + 1];
      lead.push(...(value === undefined ? [arg] : [arg, value]));
      i += value === undefined ? 1 : 2;
    } else {
      break;
    }
  }
  if (lead.length === 0) return { argv: [...argv], command: [...argv] };
  const rest = argv.slice(i);
  if (rest.length === 0) {
    // A profile flag with no name is shown with the placeholder it needs, so the form printed is a whole one.
    const shown = lead.map((f, n) =>
      (f === "-p" || f === "--profile") && n === lead.length - 1 ? `${f} <profile>` : f === "--profile=" ? "--profile=<profile>" : f,
    );
    throw new UsageError(
      `No command given after \`${lead.join(" ")}\` — global flags modify a command: \`xanosdk <command> ${shown.join(" ")}\`.`,
      { helpFor: {} },
    );
  }
  return { argv: [...rest, ...lead], command: rest };
}

/**
 * Run a command at its project's root when it was typed in a directory inside
 * the project (`cd xano && xanosdk tables`) — where `status` there already finds
 * the project, and where the entry, the lock and every tracked record in
 * `.xano/` live. Every command that reads or writes that state goes through
 * here: the ones defaulting to "the backend this project last deployed to"
 * (`tables`, `test`, `env`, `impersonate`, `local token`, …) refused
 * from a subdirectory, and a deploy from there landed at the root, so the next
 * bare command refused again.
 *
 * `positional` says what the first positional is (see `PositionalKind`): an
 * entry path decides the project itself, a `publish <dir>` is rebased, and a
 * name is never touched. The root is named on stderr, since paths the run
 * prints are read from there. See `enterProjectRoot`.
 */
/** Verbs run at the project root that print and read no path relative to it — no root note. */
const PATHLESS_VERBS: Readonly<Record<string, ReadonlySet<string>>> = {
  ephemeral: new Set(["list", "get", "delete"]),
  tenant: new Set(["list", "get", "delete", "details"]),
  release: new Set(["list", "show", "delete"]),
  "local": new Set(["token", "stop"]),
  test: new Set(["list", "run", "run-all"]),
};

/**
 * Whole commands, verb-less, that print and read no project-relative path —
 * `tables` from a subdirectory printed the root note and then no path (E2E
 * pass 25). `status` and `whoami` never enter the root at all.
 */
const PATHLESS_COMMANDS: ReadonlySet<string> = new Set(["tables", "impersonate"]);

/** Whether this run prints no path relative to the project root — see {@link PATHLESS_VERBS}. */
export function isPathlessRun(args: Pick<ParsedArgs, "command" | "subcommand">): boolean {
  const command = args.command ?? "";
  return PATHLESS_COMMANDS.has(command) || PATHLESS_VERBS[command]?.has(args.subcommand ?? "") === true;
}

async function atProjectRoot(
  args: ParsedArgs,
  command: (args: ParsedArgs) => Promise<void>,
  positional?: PositionalKind,
): Promise<void> {
  const { enterProjectRoot } = await import("./xanosdk-project.js");
  const entered = enterProjectRoot(args, process.cwd(), positional);
  if (entered === undefined) return command(args);
  // A verb that prints and reads no project-relative path (`ephemeral list`,
  // `local token`) runs at the root for its tracked records alone, so
  // the note would explain paths it never prints.
  if (isPathlessRun(args)) {
    setHintContext(entered.args);
    try {
      return await command(entered.args);
    } finally {
      entered.restore();
      setHintContext(args);
    }
  }
  // Said when the run first prints anything, or when it fails on something
  // other than its own arguments — never ahead of an argument refusal, which
  // names no path, and never for a run that prints nothing at all.
  // Not "paths below are relative to it": the reruns it prints are spelled from
  // where the reader typed (E2E pass 24), so that header contradicted them.
  const note = `Using the project at ${entered.root}; printed paths and commands read from where you typed them.\n`;
  const errWrite = process.stderr.write;
  const outWrite = process.stdout.write;
  let noted = false;
  const unwrap = (): void => {
    process.stderr.write = errWrite;
    process.stdout.write = outWrite;
  };
  const sayNote = (): void => {
    if (noted) return;
    noted = true;
    unwrap();
    errWrite.call(process.stderr, note);
  };
  process.stderr.write = function (...rest: Parameters<typeof errWrite>) {
    sayNote();
    return errWrite.apply(process.stderr, rest);
  } as typeof errWrite;
  process.stdout.write = function (...rest: Parameters<typeof outWrite>) {
    sayNote();
    return outWrite.apply(process.stdout, rest);
  } as typeof outWrite;
  setHintContext(entered.args);
  try {
    await command(entered.args);
  } catch (err) {
    if (!isUsageError(err)) sayNote();
    throw err;
  } finally {
    if (!noted) unwrap();
    entered.restore();
    setHintContext(args);
  }
}

/** `deploy`/`secrets fill`: an entry or bundle PATH typed as the positional, not a backend name. */
function entryPositional(args: ParsedArgs): PositionalKind | undefined {
  if (args.bundlePositional === true) return "entry";
  return args.file !== undefined && !isKindShapedOrBare(args.file) ? "entry" : undefined;
}

/** A deploy positional naming a backend rather than a path (`release:x`, `workspace`). */
function isKindShapedOrBare(raw: string): boolean {
  return isKindShaped(raw) || (BARE as readonly string[]).includes(raw);
}

/**
 * `--version`/`-v` written after a command that has no `--version` of its own:
 * the global flag help and completion list, so it prints the CLI's version.
 * `whoami --version` said "--version expects an engine version", and
 * `status -v` "Unknown flag -v". Not when a value follows (`deploy --version
 * v0.1.5` is an engine version on the wrong command, refused as such), not on
 * a verb that DOES take one (`local update --version v0.1.5`), not past
 * `--`, and never on `env set`, whose value may be `-v`.
 */
export function globalVersionAsked(argv: readonly string[]): boolean {
  const at = globalVersionToken(argv);
  if (at === undefined) return false;
  const next = at.own[at.index + 1];
  return next === undefined || next.startsWith("-");
}

/**
 * `status -v extra`, `tables --version local`: the global version flag
 * followed by a positional. Neither reading is safe to guess — the run the
 * reader wanted, or the version — so it is one usage error naming both ways
 * out, never "Unknown flag -v. Did you mean: --version". An engine-version-
 * shaped value (`whoami --version v0.1.5`) keeps its own refusal: that is an
 * engine version on a command that takes none.
 */
export function globalVersionMisuse(argv: readonly string[]): UsageError | undefined {
  const at = globalVersionToken(argv);
  if (at === undefined) return undefined;
  const flag = at.own[at.index]!;
  const next = at.own[at.index + 1];
  if (next === undefined || next.startsWith("-")) return undefined;
  if (flag === "--version" && /^v?\d/.test(next)) return undefined;
  const shown = next.includes("=") ? `${flagName(next)}=…` : next;
  const where = [argv[0], NOUN_COMMANDS.has(argv[0]!) ? argv[1] : undefined].filter((t) => t !== undefined).join(" ");
  return new UsageError(
    `\`${flag}\` prints the CLI version and takes no argument, so "${shown}" after it was not read. ` +
      `Run \`xanosdk --version\` on its own, or drop \`${flag}\` from \`xanosdk ${where}\`.`,
    { hintFor: { command: argv[0]! } },
  );
}

/**
 * Spellings that consume the NEXT token as their value (`--name <n>`,
 * `--profile, -p <name>`), read off each registry row's spec: whatever follows
 * the spellings is a separated value. `--name -v` is `--name` missing its
 * value, never a version request.
 */
const SEPARATED_VALUE_SPELLINGS: ReadonlySet<string> = new Set(
  Object.values(FLAGS).flatMap(({ spec }) => {
    const m = /^((?:--?[\w-]+)(?:,\s*-[\w-]+)*)\s+\S/.exec(spec);
    return m === null ? [] : m[1]!.split(/,\s*/).filter((t) => t !== "--version" && t !== "-v");
  }),
);

/** Where the global `--version`/`-v` sits in a command's own tokens, when it is one. */
function globalVersionToken(argv: readonly string[]): { own: readonly string[]; index: number } | undefined {
  const [command, ...rest] = argv;
  if (command === undefined || !isCommand(command)) return undefined;
  const verb = NOUN_COMMANDS.has(command) ? rest[0] : undefined;
  if (command === "env" && verb === "set") return undefined;
  if (flagRefFor(command, verb, "engine-version") !== undefined) return undefined;
  const end = rest.indexOf("--");
  const own = end === -1 ? rest : rest.slice(0, end);
  for (let i = 0; i < own.length; i++) {
    const a = own[i]!;
    if (a === "--version" || a === "-v") return { own, index: i };
    // A value-taking flag consumes what follows as far as this check goes:
    // the parser refuses `--name -v` as `--name` missing its value.
    if (SEPARATED_VALUE_SPELLINGS.has(a)) i += 1;
  }
  return undefined;
}

async function dispatch(rawArgv: string[]): Promise<void> {
  // `xanosdk -- whoami`: a leading end-of-options marker ends nothing — every
  // token is still to come — so it is dropped rather than read as a flag.
  while (rawArgv[0] === "--") rawArgv = rawArgv.slice(1);
  const { argv, command: typed } = hoistLeadingGlobalFlags(rawArgv);
  // `init --web` is resolved before EITHER of the two steps below, and it is
  // the only form that is. It does not parse its arguments — it forwards them
  // to a package it launches — so it must not meet a parser that rejects flags
  // it has never heard of, and it must not meet a help resolver that would
  // answer `--help` on the launched package's behalf. See init-web.ts.
  //
  // The flag is detected in the RAW argv and removed; everything else goes
  // across untouched, in the order it was written. `xanosdk help init` still
  // reaches the registry's own (offline) description: that form leads with
  // `help`, so it never arrives here.
  // Global flags written BEFORE `init` belong to xanosdk, not to the launched
  // package, so the forwarded arguments are the command's own (`typed`).
  if (typed[0] === "init") {
    const web = typed.indexOf("--web", 1);
    if (web !== -1) {
      const { runInitWebCommand } = await import("./init-web.js");
      return runInitWebCommand([...typed.slice(1, web), ...typed.slice(web + 1)]);
    }
  }

  // Help is resolved from the raw argv FIRST — see resolveHelpRequest for why
  // this has to precede parseArgs. Requested help is output, so it goes to
  // stdout and the process exits 0.
  // Before help: `-v` anywhere no value claims it prints the version —
  // `xanosdk help -v` and `status --help -v` included, as `status -v` does.
  if (globalVersionAsked(argv)) {
    if (argv.includes("--json")) writeJson({ version: readVersion() });
    else process.stdout.write(`${readVersion()}\n`);
    return;
  }

  const helpRequest = resolveHelpRequest(argv);
  if (helpRequest) {
    // A topic the registry doesn't know is a FAILURE, not a help request: it
    // exits non-zero with the closest match, exactly as `xanosdk frobnicate` does.
    if (helpRequest.unknownTopic !== undefined) throw unknownHelpTopic(helpRequest.unknownTopic);
    if (helpRequest.unknownCommand !== undefined) throw unknownCommand(helpRequest.unknownCommand, { help: true });
    if (helpRequest.unknownSubcommand !== undefined && helpRequest.command !== undefined) {
      throw unknownSubcommand(helpRequest.command, helpRequest.unknownSubcommand, helpRequest.positionals ?? []);
    }
    // `--json` asks for the registry as a document; piped without it, help stays
    // text — an agent's `--help | …` reads the reference, not a schema.
    if (argv.includes("--json")) {
      const { helpDocument } = await import("./commands.js");
      writeJson({ version: readVersion(), ...helpDocument(helpRequest) });
      return;
    }
    // Help is read piped too (an agent's `--help | …`): its commands carry the run's prefix either way.
    process.stdout.write(terminalText(withCliPrefix(renderHelpFor(helpRequest, stdoutStyle(), readVersion()))));
    return;
  }

  const versionMisuse = globalVersionMisuse(argv);
  if (versionMisuse !== undefined) throw versionMisuse;

  // Everything parseArgs refuses is fixed by retyping the command line (a bad
  // `--port`, a malformed `--static-env`, an invalid `-p` name), so it reports
  // as a usage failure — `SDK_USAGE` under `--json` — even where the parse
  // threw a plain Error. No help block: each message names the value it wants.
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    // `deploy`'s refusals all point at its help (E2E pass 13 L5): a value the
    // parse refused (`--expires-hours 25`, `--concurrency 0`, `--frozen-lock
    // --no-lock`) is a usage mistake like the ones the command refuses later.
    const hintFor =
      argv[0] === "deploy" && (!isUsageError(err) || (err.hintFor === undefined && err.helpFor === undefined))
        ? { hintFor: { command: "deploy" } }
        : undefined;
    if (isUsageError(err) && hintFor === undefined) throw err;
    throw new UsageError(err.message, { ...(isUsageError(err) && err.suggestion !== undefined ? { suggestion: err.suggestion } : {}), ...hintFor });
  }
  // Every printed `xanosdk …` hint carries this run's `--config`/`--local-auth`/
  // `--profile`, including the ones printed far below any `args`.
  setHintContext(args);
  runArgs = args;
  noteRunArgs(args);
  // A `--json` run's update nudge rides in its document, not after it.
  if (isMachineOutput(args)) (await import("./update-check.js")).routeUpdateNoticeToDocument();
  const { command } = args;
  // `-` is stdout, as `workspace export --path -` spells it — never a file named `-`.
  const out = args.out === "-" ? undefined : args.out;

  if (command === undefined) {
    printHelp();
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    // Bare unless `--json` is passed by name — not on a mere pipe, the way
    // `local token` is: `$(xanosdk version)` is the form this exists for,
    // and it is always piped.
    // `xanosdk -v extra` read nothing of "extra" and exited 0 — the same misuse
    // `status -v extra` refuses, refused in the same words (E2E pass 25).
    const stray = [args.subcommand, ...args.positionals].find((t) => t !== undefined);
    if (stray !== undefined) {
      // Only the flag spellings reach here with one: the parser refuses `version extra` itself.
      throw new UsageError(
        `\`${command}\` prints the CLI version and takes no argument, so "${stray}" after it was not read. ` +
          `Run \`xanosdk --version\` on its own.`,
        { hintFor: {} },
      );
    }
    if (args.json) writeJson({ version: readVersion() });
    else process.stdout.write(`${readVersion()}\n`);
    return;
  }
  if (command === "init") {
    // Node-only (node:fs + child_process for install + a readline prompt);
    // lazily imported like the other Node-only commands so the browser-safe
    // authoring bundle never pulls it in.
    const { runInitCommand } = await import("./init-command.js");
    return runInitCommand(args);
  }
  if (command === "completion") {
    // Pure string building over the registry, but lazily imported all the same:
    // almost no run needs it, and the common path should not carry it.
    const { isCompletionShell, runCompletionCommand, COMPLETION_SHELLS, UNSUPPORTED_SHELLS } = await import(
      "./completion.js"
    );
    const shell = args.positionals[0];
    if (shell === undefined) throw missingArgument("shell", { command: "completion" });
    if (!isCompletionShell(shell)) {
      // The message lists every shell that works, which is all the help block
      // would add. A spelling suggestion only for a misspelling: `pwsh` is two
      // edits from `bash` and is a shell of its own, not a typo of one.
      const known = UNSUPPORTED_SHELLS.has(shell.toLowerCase());
      throw new UsageError(
        `\`xanosdk completion\`: ${known ? `${shell} is not supported` : `unknown shell "${shell}"`}. ` +
          `Supported: ${COMPLETION_SHELLS.join(", ")}.`,
        known ? {} : { suggestion: suggest(shell, COMPLETION_SHELLS) },
      );
    }
    // The script IS the output — a shell sources it — so there is no document to
    // render in its place. An explicit `--json` is refused rather than ignored;
    // a piped stdout is not, since `completion bash > file` is how it is used.
    if (args.json) {
      throw new UsageError(
        "`xanosdk completion` prints a shell script to source, and has no JSON form. Drop `--json`.",
        { hintFor: { command: "completion" } },
      );
    }
    return runCompletionCommand(shell);
  }
  if (command === "upgrade") {
    // Node-only (the npm spawn plus the project reconciliation reach for
    // node:fs/child_process); lazily imported like the other Node-only commands
    // so the browser-safe authoring bundle never pulls it in.
    const { runUpgradeCommand } = await import("./upgrade-command.js");
    return runUpgradeCommand(args);
  }
  if (command === "lock") {
    const { runLockCommand } = await import("./lock-commands.js");
    // At the project root, like every command reading its state, so the
    // root-relative `lock …` commands this CLI prints work from anywhere in the
    // project. A `xano.lock` in the directory it was typed in is still the one
    // `rename`/`import` default to — named, so the move cannot lose it. At the
    // root itself the command resolves its own default: a stray root lock beside
    // a nested `xano/index.ts` is not the one `export` reads (E2E pass 24).
    const verb = args.positionals[0];
    const { isProjectDir } = await import("./xanosdk-project.js");
    const here =
      verb !== "prune" &&
      args.lockPath === undefined &&
      args.entryPath === undefined &&
      existsSync("xano.lock") &&
      !isProjectDir(process.cwd())
        ? { ...args, lockPath: "xano.lock" }
        : args;
    // Only `prune <entry>` and `import <bundle>` take a path after the verb;
    // `rename <kind> <old> <new>` takes names, and a kind that happens to name
    // a directory where it was typed (`table`, from `xano/`) is still a kind.
    return atProjectRoot(here, runLockCommand, verb === "prune" || verb === "import" ? "verb-path" : undefined);
  }
  if (command === "login") {
    // OAuth login is Node-only (node:http/node:crypto/child_process); lazily
    // imported like `push`/`lock` so `compile`/`export`/the browser-safe bundle
    // never pull it in.
    const { runLoginCommand } = await import("./login-command.js");
    return runLoginCommand(args);
  }
  if (command === "logout") {
    // Node-only (OAuth revoke + file removal); lazily imported like `login`.
    const { runLogoutCommand } = await import("./logout-command.js");
    return runLogoutCommand(args);
  }
  if (command === "deploy") {
    // The deploy core lives in its own (Node-only) module so the bin's other
    // commands never pay its import cost.
    const { runDeployCommand } = await import("./deploy-command.js");
    return atProjectRoot(args, runDeployCommand, entryPositional(args));
  }
  if (command === "ephemeral") {
    // Lazily imported like the other Node-only command modules.
    const { runEphemeralCommand } = await import("./ephemeral-command.js");
    return atProjectRoot(args, runEphemeralCommand);
  }
  if (command === "local") {
    // Node-only (it runs the engine's own verbs and reads the binary cache);
    // lazily imported like the other Node-only command modules.
    const { runLocalEngineCommand } = await import("./local-engine-command.js");
    // The verbs that read this project's engine record or pin; `list` and
    // `cache` are the machine's, and run where they are typed.
    const project = ["token", "stop", "update"].includes(args.subcommand ?? "");
    return project ? atProjectRoot(args, runLocalEngineCommand) : runLocalEngineCommand(args);
  }
  if (command === "env") {
    if (args.subcommand === "set" || args.subcommand === "unset") {
      // Node-only (fetch + stdin); lazily imported like the sibling command modules.
      const { runEnvVarCommand } = await import("./env-var-command.js");
      return atProjectRoot(args, (a) => runEnvVarCommand(a, args.subcommand as "set" | "unset"));
    }
    if (args.subcommand !== "pull") throw unknownSubcommand("env", args.subcommand);
    // Node-only (fs + fetch); lazily imported like the sibling command modules.
    const { runEnvPullCommand } = await import("./env-pull-command.js");
    return atProjectRoot(args, runEnvPullCommand);
  }
  if (command === "secrets") {
    if (args.subcommand !== "fill") throw unknownSubcommand("secrets", args.subcommand);
    // Node-only (fs + the entry loader); lazily imported like its siblings.
    const { runSecretsFillCommand } = await import("./secrets-fill-command.js");
    return atProjectRoot(args, runSecretsFillCommand, entryPositional(args));
  }
  if (command === "release") {
    // The release OBJECT's surface. Compiling a local entry and merging it into
    // the workspace is `deploy --to`.
    const { runReleaseCommand: runReleaseNs } = await import("./release-ns-command.js");
    return atProjectRoot(args, runReleaseNs);
  }
  if (command === "pull") {
    const { runPullCommand } = await import("./pull-command.js");
    // A bundle FILE is refused by pull itself, from where it was typed — its
    // remedy is a command to run there.
    const first = args.positionals[0];
    const file = first !== undefined && !isKindShaped(first) && (/\.json$/i.test(first) || /[\\/]/.test(first));
    return file ? runPullCommand(args) : atProjectRoot(args, runPullCommand);
  }
  if (command === "generate") {
    const { runGenerateCommand } = await import("./generate-command.js");
    return runGenerateCommand(args);
  }
  if (command === "tables") {
    const { runTablesCommand } = await import("./tables-command.js");
    return atProjectRoot(args, runTablesCommand);
  }
  if (command === "impersonate") {
    const { runImpersonateCommand } = await import("./impersonate-command.js");
    return atProjectRoot(args, runImpersonateCommand);
  }
  if (command === "promote") {
    const { runPromoteCommand } = await import("./promote-command.js");
    return atProjectRoot(args, runPromoteCommand);
  }
  if (command === "publish") {
    const { runPublishCommand } = await import("./publish-command.js");
    return atProjectRoot(args, runPublishCommand, "path");
  }
  if (command === "tenant") {
    const { runTenantCommand } = await import("./tenant-command.js");
    return atProjectRoot(args, runTenantCommand);
  }
  if (command === "test") {
    // Node-only (fetch + OAuth); lazily imported like the sibling env commands.
    const { runTestCommand } = await import("./test-command.js");
    return atProjectRoot(args, runTestCommand);
  }
  if (command === "workspace") {
    // Read-only by design: pull from the real workspace, deploy to a disposable
    // one. See the module header for why there is no `workspace deploy`.
    const { runWorkspaceCommand } = await import("./workspace-command.js");
    return runWorkspaceCommand(args);
  }
  if (command === "status") {
    // Node-only (fetch + OAuth + the local state file); lazily imported like
    // the other account commands.
    const { runStatusCommand } = await import("./status-command.js");
    return runStatusCommand(args);
  }
  if (command === "whoami") {
    const { runWhoamiCommand } = await import("./whoami-command.js");
    return runWhoamiCommand(args);
  }
  if (command === "profile") {
    // The verb check lives in the handler, which reads the registry — including
    // the `removed` entry that sends `profile me` to `whoami` by name. Edit
    // distance would not surface it now the family has real verbs.
    const { runProfileCommand } = await import("./profile-command.js");
    return runProfileCommand(args);
  }
  if (command === "marketplace") {
    // Three public catalogue reads plus the three npm-backed lifecycle verbs.
    // The reads take no token: discovery has to work before you have logged in.
    // Validated before the import, so a mistyped verb never loads a module it
    // has no use for.
    if (!["list", "search", "details", "install", "reinstall", "remove"].includes(args.subcommand ?? "")) {
      throw unknownSubcommand("marketplace", args.subcommand);
    }
    // Node-only (node:fs + the npm spawn); lazily imported like the other
    // Node-only commands so the browser-safe authoring bundle stays clean.
    const marketplace = await import("./marketplace-command.js");
    const { withCatalogueRerun } = await import("./marketplace-resolve.js");
    try {
      if (args.subcommand === "list") return await marketplace.runMarketplaceListCommand(args);
      if (args.subcommand === "search") return await marketplace.runMarketplaceSearchCommand(args);
      if (args.subcommand === "details") return await marketplace.runMarketplaceDetailsCommand(args);
      // The three writing verbs change the PROJECT's package.json, so from a
      // directory inside one they run at its root, as `deploy` does — refused
      // there as "No package.json in …/src" before.
      if (args.subcommand === "reinstall") return await atProjectRoot(args, marketplace.runMarketplaceReinstallCommand);
      if (args.subcommand === "remove") return await atProjectRoot(args, marketplace.runMarketplaceRemoveCommand);
      return await atProjectRoot(args, marketplace.runMarketplaceInstallCommand);
    } catch (err) {
      throw await withCatalogueRerun(err, args, `marketplace ${args.subcommand}`);
    }
  }
  if (command === "preflight") {
    // Node-only (fetch/fs/env + the round-trip stack); lazily imported like the
    // other Node-only commands so the browser-safe authoring bundle stays clean.
    const { runPreflightCommand } = await import("./preflight-command.js");
    return runPreflightCommand(args);
  }
  if (command !== "compile" && command !== "export" && command !== "paths" && command !== "routes") {
    throw unknownCommand(command);
  }
  if (!args.file) {
    throw missingArgument("file", { command });
  }

  if (command === "compile") {
    return runCompile(args);
  }

  if (command === "paths" || command === "routes") {
    return runPaths(args);
  }

  // export
  // Toolchain plugins load BEFORE the entry, and it is not optional for them:
  // loading the entry unregisters the TypeScript loader, which a later dynamic
  // import would trip over in a source checkout — so a plugin imported after it
  // could never fire at all.
  const { discoverToolchainPlugins } = await import("./toolchain-modules.js");
  // `unconfigured` reaches the reader on STDERR here and nowhere else, unlike
  // `deploy`, whose summary carries it. Not an oversight: this command's stdout
  // IS the bundle, so there is no summary document to add a field to, and
  // adding one to the artifact would corrupt the thing the command exists to
  // produce. A CI job that wants the list machine-readably runs `deploy`, or
  // reads stderr.
  const toolchain = await discoverToolchainPlugins(process.cwd(), {
    frozen: args.frozenLock === true || args.check === true,
  });
  // An `--out` that cannot be written is refused BEFORE the compile writes
  // xano.lock — otherwise the run reports the lock it wrote, then fails saying
  // nothing was written.
  if (out && !args.check) {
    const { assertWritableTarget } = await import("./output-target.js");
    assertWritableTarget(out, "--out");
  }
  const { bundle: json, bundleObject, omittedSeedTables, lock: lockOutcome, declaredEnvNames } = await compileBundle(args);
  if (omittedSeedTables.length > 0 && !args.check) {
    const names = omittedSeedTables.map((n) => `"${n}"`).join(", ");
    info(
      `Exported bundle omits seed rows for ${countOf(omittedSeedTables.length, "table")}: ${names}. ` +
        `Seed is applied only by \`xanosdk deploy <entry>\` — deploying this bundle via ` +
        `\`--bundle\` ships schema without seed data.`,
    );
  }
  const { hostedIconOwners } = await import("../fields/hosted-file.js");
  const hostedOwners = hostedIconOwners(((bundleObject as { payload?: Record<string, unknown> }).payload ?? {}));
  if (hostedOwners.length > 0 && !args.check) {
    warn(
      `Exported bundle names hostedFile() icons whose files it does not carry: ${hostedOwners.join(", ")}. ` +
        `Deploying it with \`--bundle\` is refused; \`xanosdk deploy ${shellWord(pastePath(args.file))}\` ships the files.`,
      "export.hosted-files-omitted",
    );
  }
  // BEFORE the artifact is emitted, for the same reason `deploy` fires before
  // the upload: a run that is going to fail should not first hand out the thing
  // it is about to refuse. Under `--frozen-lock` especially — a stale committed
  // artifact fails the command, and writing `--out` first would leave a bundle
  // on disk from a run that reported failure.
  const { runBundleHooks } = await import("./toolchain-hooks.js");
  await runBundleHooks(
    toolchain.loaded,
    {
      bundle: bundleObject,
      entry: args.file,
      cwd: process.cwd(),
      command: "export",
      frozen: args.frozenLock === true || args.check === true,
      sdkVersion: readVersion(),
    },
    "",
  );

  const { refreshEnvExample, bundleEnvNames } = await import("./env-example-refresh.js");
  const { backendDirFor } = await import("./backend-dir.js");
  // The committed template lists what the SOURCE declares, never a name this
  // build was handed by `--env-var` / `--backend-env-file` (E2E pass 25): those
  // are one run's extras, and the template is what a teammate fills in.
  const declaredSet = new Set(declaredEnvNames);
  // The backend directory's `.env.example` is its OWN entry's template. A side
  // entry outside it (`xanosdk export ./p6.ts` at the project root, with `--out`
  // elsewhere) declares its own env, and writing that over the committed
  // template rewrote the project's file with another source's names (E2E pass
  // 29). Only an entry inside the backend directory reads or writes it — and
  // of those, a side entry below it (`xano/diag/index.ts`) only when the
  // directory has no `index.ts` of its own: the main entry's names are the
  // template's, and the side entry's set dropped them.
  const templateDir = backendDirFor(args.file);
  const ownsTemplate =
    isWithin(resolve(args.file), templateDir) &&
    (dirname(resolve(args.file)) === templateDir || !existsSync(join(templateDir, "index.ts")));
  const templateEnv = Object.fromEntries(
    Object.entries(bundleEnvNames(bundleObject)).filter(([name]) => declaredSet.has(name)),
  );
  // A CLI of another version than the project's installed SDK words the
  // template as its own version does: it leaves the file to the installed CLI
  // rather than rewriting it into a form the project's own check calls stale.
  // The project is the ENTRY's, wherever the command was typed from: a global
  // CLI run from the project's parent is still writing that project's files.
  const { skewedProjectSdk, skewNote, installedCliCommand } = await import("./project-sdk.js");
  const projectSdk = skewedProjectSdk(dirname(resolve(args.file)), readVersion());
  // Under skew every remedy names the installed CLI: the running one leaves the
  // template alone, so re-running it would loop.
  const regenerate =
    projectSdk === undefined
      ? `xanosdk export ${shellWord(pastePath(args.file))} --out ${NULL_DEVICE}`
      : installedCliCommand(projectSdk.root, (path) => `export ${path(args.file!)} --out ${NULL_DEVICE}`);
  if (args.check) {
    // Everything an export decides has been decided by now — every guard, the
    // seed rows, the lock gate, each toolchain module's frozen check — and every
    // one of them throws. The committed `.env.example` is the one artifact left:
    // an export rewrites it, so a check that never compared it passed while the
    // template a teammate reads omitted a declared name. Reaching past it is the pass.
    const staleEnvExample = ownsTemplate
      ? refreshEnvExample(templateDir, templateEnv, { write: false })
      : undefined;
    if (staleEnvExample !== undefined) {
      // Which way it drifted: a name the source declares that the template
      // omits, or a stale one it still lists — "does not list" read wrong for
      // the second (E2E pass 28).
      const listed = new Set(
        [...readFileSync(staleEnvExample, "utf8").matchAll(/^# ([^\s=`]+)=/gm)].map((m) => m[1]!),
      );
      const quoted = (names: string[]): string => names.map((n) => `\`${n}\``).join(", ");
      const missing = Object.keys(templateEnv).filter((n) => !listed.has(n));
      const extra = [...listed].filter((n) => !(n in templateEnv));
      const drift = [
        missing.length > 0 ? `omits ${quoted(missing)}, which this source declares` : "",
        extra.length > 0 ? `still lists ${quoted(extra)}, which this source no longer declares` : "",
      ].filter(Boolean);
      // The same names in another version's words: the installed CLI's wording is
      // the one the project commits, so there is nothing here to fail on.
      if (drift.length === 0 && projectSdk !== undefined) {
        info(skewNote(displayPath(staleEnvExample), readVersion(), projectSdk.version, regenerate));
      } else {
        throw new CliError(
          DRIFT,
          `--check: ${displayPath(staleEnvExample)} ` +
            `${
              drift.length > 0
                ? drift.join(", and ")
                : `lists the env names this source declares, but in other words than @xano/sdk ${readVersion()} renders the template`
            }. ` +
            `Run \`${regenerate}\` locally — it rewrites the ` +
            `template (names only, never a value) and writes the bundle nowhere — then commit it and retry.`,
        );
      }
    }
    const lockPath = resolveLockPath(args, args.file);
    // Named as every other report names it — relative, not the absolute path —
    // and in the one shape `export --out` reports it: `{ path, changed }`. A
    // check never changes it.
    const lock = !args.noLock && existsSync(lockPath) ? { path: displayPath(lockPath), changed: false } : null;
    if (isMachineOutput(args)) writeJson({ checked: resolve(args.file), lock, written: false });
    else {
      success(
        `Checked ${args.file}: ` +
          (args.noLock
            ? `it compiles and every guard, toolchain check and .env.example passes; no xano.lock yet, so identities were not ` +
              `checked — \`${regenerate}\` records one to commit.`
            : lock === null
              ? "nothing to record in xano.lock."
              : "xano.lock is up to date.") +
          ` Nothing was written.`,
      );
    }
    return;
  }

  // An authored project's committed `.env.example` follows the env names its
  // source declares — names only. Only a pull rewrote it before, so a project
  // that declared five names in `workspaceConfig({ env })` kept a template
  // saying it declared none. A template the SDK did not write is left alone.
  // With none there, one is written — the file `xano/.env` is filled from.
  const hadEnvExample = existsSync(join(templateDir, ".env.example"));
  const held = ownsTemplate && projectSdk !== undefined ? refreshEnvExample(templateDir, templateEnv, { write: false }) : undefined;
  if (held !== undefined) {
    warn(skewNote(displayPath(held), readVersion(), projectSdk!.version, regenerate), "export.env-example-cli-skew");
  }
  let refreshed: string | undefined;
  try {
    refreshed = ownsTemplate && projectSdk === undefined ? refreshEnvExample(templateDir, templateEnv) : undefined;
  } catch (err) {
    if (isUnwritableError(err)) throw unwritableError(join(templateDir, ".env.example"));
    throw err;
  }
  if (refreshed !== undefined) {
    info(`${hadEnvExample ? "Updated" : "Wrote"} ${displayPath(refreshed)} to list the env names this source declares.`);
  }

  if (out) {
    // A bundle carries the env values and documentation tokens it was built
    // with, in cleartext — that is what makes it deployable. On disk it is then
    // a secrets file: owner-only, and said so once, so it is not committed or
    // attached somewhere by someone who took it for source. The shared writer
    // every bundle-to-disk command uses: it creates the parent, and chmods a
    // regular file only (`--out /dev/null` is EPERM for anyone but root).
    const { secretsCarriedBy } = await import("../deploy/live-diff.js");
    const { writeExportFile } = await import("./output-target.js");
    // The pre-check above cannot see everything (a disk filling up), and by now
    // the lock may have landed: the refusal must not claim nothing was written.
    const written = lockOutcome?.changed ? `Only ${lockOutcome.path} was written` : undefined;
    writeExportFile(out, json + "\n", secretsCarriedBy(bundleObject), "--out", written);
    reportWrote(args, out, lockOutcome);
  } else {
    process.stdout.write(json + "\n");
    // A file holding these is written owner-only and says so; stdout has no
    // such protection, so the same fact is said on stderr — as `workspace
    // export --path -` says it.
    const { secretsCarriedBy } = await import("../deploy/live-diff.js");
    const { secretsPhrase } = await import("./output-target.js");
    const secrets = secretsCarriedBy(bundleObject);
    // Deliberately NOT an `exportWarn`: `--strict` fails on the build's
    // defects, and this is a notice about the output the user asked for — a
    // workspace that declares env values carries them in every bundle, so
    // counting it would make `--strict` to stdout unusable for any such project.
    // It is also printed after the bundle is written, past the strict gate.
    if (secrets.length > 0) {
      warn(
        `The export carries ${secretsPhrase(secrets)} in cleartext — written to stdout, where no file ` +
          `permission protects it; do not commit or log it.`,
        "secrets.cleartext-stdout",
      );
    }
  }
}

/**
 * Say where `--out` put the artifact. The artifact went to the file, so stdout
 * carries either the document naming it (machine output) or nothing — a
 * `Wrote <path>` line there would be the one thing a script parses and chokes on.
 */
function reportWrote(
  args: ParsedArgs,
  out: string,
  lock?: CompiledBundle["lock"],
): void {
  // `lock` for a workspace export — `compile` builds one def and keeps no lock.
  if (isMachineOutput(args)) {
    // `written` as `--check` reports it, so one field answers "did this write" either way.
    writeJson({ out: resolve(out), written: true, ...(lock === undefined ? {} : { lock }) });
  } else success(`Wrote ${out}`);
}

/**
 * Bring a project's agent guidance back in line with the installed version.
 *
 * Called from {@link compileBundle}, which is the workspace compile behind
 * `export`, `deploy`, `release`, and `preflight` — `deploy` being the one an
 * agent's loop actually runs. An earlier version hung this off the `export`
 * tail alone, so an agent running `npm run xano:deploy` never got a refresh.
 *
 * `compile` and `paths`/`routes` do NOT route through here: they answer narrow
 * questions about a single def or a route table rather than building a
 * workspace, and neither is a loop worth writing to a user's tree from.
 *
 * It only ever updates a managed block that already exists, is silent in CI and
 * when no coding agent is detected, and never fails the compile — see
 * `agent-file-refresh.ts` for the gates. `--no-refresh` turns it off outright,
 * because this is still a write to the user's tree from a command they ran to
 * BUILD something. Lazily imported so the browser-safe bundle never pulls in fs.
 */
export async function refreshAgentGuidance(args: ParsedArgs): Promise<void> {
  if (args.noRefresh) return;
  // A run that promises to write nothing writes nothing — AGENTS.md included:
  // `export --check` and `--frozen-lock` (the CI guards, which assert committed
  // state rather than change it) and `--dry-run`.
  if (args.check || args.frozenLock || args.dryRun) return;
  try {
    // A CLI of another version than the project's installed SDK would stamp its
    // own guidance over the one `xano:check`'s CLI renders: it says what it left.
    // The guidance is the working directory's when it has one; from a project's
    // parent it is the entry's project's — and so is the SDK that words it.
    const { installedSdk, skewedProjectSdk, skewNote, installedCliCommand } = await import("./project-sdk.js");
    const entryProject = args.file === undefined ? undefined : installedSdk(dirname(resolve(args.file)))?.root;
    const projectDir =
      existsSync(join(process.cwd(), "AGENTS.md")) || entryProject === undefined ? process.cwd() : entryProject;
    const projectSdk = skewedProjectSdk(projectDir, readVersion());
    const { refreshAgentFiles } = await import("./agent-file-refresh.js");
    if (projectSdk !== undefined) {
      const stale = refreshAgentFiles({ projectDir, sdkVersion: readVersion(), write: false });
      const file = args.file;
      const command = installedCliCommand(
        projectSdk.root,
        (path) => `export${file === undefined ? "" : ` ${path(file)}`} --out ${NULL_DEVICE}`,
      );
      for (const path of stale) info(skewNote(displayPath(join(projectDir, path)), readVersion(), projectSdk.version, command));
      return;
    }
    const refreshed = refreshAgentFiles({
      projectDir,
      sdkVersion: readVersion(),
    });
    for (const path of refreshed) {
      process.stderr.write(`Refreshed ${displayPath(join(projectDir, path))} for @xano/sdk ${readVersion()}.\n`);
    }
  } catch {
    // A courtesy that cannot be the reason a compile fails.
  }
}

/**
 * Resolve the lock path for an entry file: `--lock=<path>` wins, else
 * `xano.lock` beside the entry (matching `export`/`compile` defaults).
 */
/**
 * The nearest `xano.lock` at or above a file's directory, falling back to the
 * beside-the-file location `export` would write. `compile` seeds names and
 * guids from it, and a single def lives a directory or two below the workspace
 * entry the lock sits beside.
 */
export function nearestLockPath(file: string): string {
  const start = dirname(resolve(file));
  let dir = start;
  for (;;) {
    const candidate = join(dir, "xano.lock");
    if (existsSync(candidate)) return candidate;
    // The project's root is as far as a def's own workspace can be; walking past
    // a package.json would adopt some other project's identities.
    if (existsSync(join(dir, "package.json"))) return join(start, "xano.lock");
    const parent = dirname(dir);
    if (parent === dir) return join(start, "xano.lock");
    dir = parent;
  }
}

/**
 * The refusal for a `--lock=<path>` whose directory is not there, or undefined
 * when it is (or no `--lock` was named). The lock is written through a temp
 * file beside it, so a missing directory failed as a raw ENOENT on that temp
 * path, with "make the directory writable" for a remedy.
 */
export function missingLockDir(args: Pick<ParsedArgs, "lockPath">): string | undefined {
  if (args.lockPath === undefined) return undefined;
  const dir = dirname(resolve(args.lockPath));
  if (existsSync(dir)) return undefined;
  return (
    `\`--lock=${args.lockPath}\`: ${displayPath(dir)}/ doesn't exist — create it, or pass a \`--lock\` path ` +
    `in an existing directory.`
  );
}

export function resolveLockPath(args: ParsedArgs, file: string): string {
  return args.lockPath !== undefined
    ? resolve(args.lockPath)
    : join(dirname(resolve(file)), "xano.lock");
}

/**
 * Does a lock file at this path parse?
 *
 * Only `--no-lock`'s refusal asks. It must distinguish a lock the project
 * committed — which `--no-lock` would silently contradict — from a corrupt one,
 * for which `--no-lock` is the documented way out. Existence alone cannot tell
 * them apart, and refusing on existence would block the escape hatch the
 * corrupt-lock error points at.
 */
function isParseableLock(lockPath: string): boolean {
  try {
    readLockFile(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The notice for a build that opted out of the lock.
 *
 * An earlier always-on version of this fired on every export and deploy and was
 * suppressed for being noise — but that one fired when unlocked was the DEFAULT,
 * at people who had not asked for it. This one only follows an explicit
 * `--no-lock`, where saying what the flag just did is confirmation rather than
 * nagging. Three consequences, one line each, because each is a thing the
 * reader would otherwise discover later and expensively.
 */
function noteUnlockedBuild(): void {
  // An info notice, not a warning: it confirms a flag the author passed, so
  // counting it under `--strict` meant `--strict --no-lock` could never pass.
  info("Building without an identity lock (`--no-lock`).");
  detail("Identities derive from names, so renaming an object becomes delete-and-create on sync.");
  // A `canonical` written on a def is emitted lock or not (E2E pass 16): only
  // the slugs nobody pinned are the instance's to choose.
  detail(
    "Public URLs not pinned in code are left for the instance to invent, and this project will not learn them; " +
      "a `canonical` written on a def still applies.",
  );
  // Not every destination: an ephemeral's landing record lives in the local
  // state file, written lock or not, so a prune there still runs.
  detail(
    "`xanosdk deploy --to <backend> --prune` needs the lock to know what this project owns there, so it is " +
      "unavailable except onto an ephemeral, whose landing record is kept in .xano/ephemeral.json instead.",
  );
}

/**
 * The notice for a lock this run CREATED.
 *
 * The lock is written by any build, so this lands on runs nobody asked for
 * a lock on — including a `preflight`, which reads as a check, and a deploy to
 * a throwaway environment, which reads as disposable. Both of those now freeze
 * public URLs that a later `deploy --to` will pin, so the durability is the part
 * that has to be said rather than the file.
 *
 * The `lock import` pointer is for the case the file cannot detect: a project
 * already released to a workspace mints slugs here that the workspace will
 * never adopt, because an unpinned slug is kept on update. Nothing writes the
 * served value back, so the lock would record a value that is not true and
 * would keep recording it. Adopting first is the only thing that fixes it.
 */
/**
 * The adopt pointer for the backend this run is deploying to — named for it
 * (E2E pass 25: `workspace export` was named for an ephemeral and a tenant).
 * The runnable form: `lock import` takes an exported bundle, so the export that
 * writes one is named too, with this run's credential and lock. None for a
 * backend this project makes or owns — the ephemeral a bare deploy tracks or
 * creates, a Xano Engine — which serves nothing this project did not land.
 */
function adoptBeforeFirstLock(
  lockPath: string,
  args: Pick<ParsedArgs, "command" | "to" | "localEngine"> | undefined,
): string | undefined {
  const deploying = args?.command === "deploy";
  if (deploying && (args.localEngine || args.to === undefined || args.to.startsWith("local"))) return undefined;
  const importLine = `\`xanosdk lock import live.json --lock=${shellWord(displayPath(lockPath))} --yes\``;
  const ending = "so the lock adopts the URLs it already serves instead of values it will not accept.";
  const target = deploying ? args.to! : "workspace";
  const colon = target.indexOf(":");
  const kind = colon === -1 ? target : target.slice(0, colon);
  const name = colon === -1 ? undefined : target.slice(colon + 1);
  if (kind === "ephemeral") {
    return (
      "Deploying to an ephemeral that already holds objects? Adopt what it serves first — " +
      `\`xanosdk ephemeral export${name === undefined || name === "" ? "" : ` ${shellWord(name)}`} --path live.json${contextFlags()}\`, ` +
      `then ${importLine} — ${ending}`
    );
  }
  // No export reads a tenant; its plan names each identity it already holds —
  // and a deploy to one writes its lock only after that plan was shown, so
  // "run --dry-run first" pointed at what the run had just printed, beside the
  // line saying it landed (E2E pass 27).
  if (kind === "tenant") return undefined;
  return (
    "Deploying to a workspace that already exists? Adopt what it serves first — " +
    `\`xanosdk workspace export --path live.json${contextFlags()}\`, then ${importLine} — ${ending}`
  );
}

export function noteLockCreated(
  lockPath: string,
  args?: Pick<ParsedArgs, "command" | "to" | "localEngine">,
  opts: { adopt?: boolean } = {},
): void {
  info(`Wrote ${displayPath(lockPath)} — commit it.`);
  detail("It pins this project's object identities and public URLs: renames stay renames, and the");
  detail("URLs stay yours. A later deploy honors what it records.");
  const adopt = opts.adopt === false ? undefined : adoptBeforeFirstLock(lockPath, args);
  if (adopt !== undefined) detail(adopt);
  // A lock created in CI is a lock the repository does not have. It is minted
  // here, shipped, and thrown away with the checkout, and the next run mints
  // another — so the identities this file exists to make stable are re-invented
  // every build, and nothing fails.
  //
  // Creation is the whole signal. A committed lock is READ, never created, so
  // reaching this line in CI already means the repository did not carry one.
  if (isCI()) {
    warn(
      "This lock was created in CI, which means the repository does not have one.",
      "lock.created-in-ci",
      [
        "It is discarded with the checkout and re-minted next run, so the identities it froze",
        "do not survive. Commit the lock, or add `--frozen-lock` to fail instead.",
      ],
    );
  }
}

/**
 * What a module's default export actually is, in words an author can act on.
 *
 * `typeof` alone is useless here — every def, every workspace and every
 * accidental object all report `object`.
 */
/** The command as the reader typed it (`release create`, `deploy`), for messages about it. */
function commandLabel(args: ParsedArgs): string {
  return [args.command ?? "export", args.subcommand].filter((p) => p !== undefined).join(" ");
}

function describeDefaultExport(def: unknown): string {
  if (def === undefined) return "no default export";
  if (def === null) return "null";
  if (Array.isArray(def)) return "an array (export one def, not a list)";
  if (typeof def !== "object") return `a ${typeof def}`;
  return "an object with no `name`";
}

async function runCompile(args: ParsedArgs): Promise<void> {
  const file = args.file!;
  // Refused here rather than by the module loader, whose "Directory import … is
  // not supported" names neither the command nor what to pass.
  if (existsSync(file) && statSync(file).isDirectory()) {
    const example = readdirSync(file).filter((n) => /\.[mc]?ts$/.test(n) && !n.endsWith(".d.ts")).sort()[0] ?? "<def>.ts";
    throw new UsageError(
      `compile: "${file}" is a directory. \`compile\` takes one module that exports a single def — ` +
        `\`xanosdk compile ${shellWord(join(file, example))}\`; for a whole workspace, \`xanosdk export <entry>\`.`,
      { hintFor: { command: "compile" } },
    );
  }
  // A lone def usually sits BELOW the workspace's lock (xano/functions/x.ts vs
  // xano/xano.lock), so the lookup walks up; `--lock` still names one outright.
  const lockPath = args.lockPath !== undefined ? resolve(args.lockPath) : nearestLockPath(file);
  // A lock NAMED with `--lock=<path>` that is not there is refused, not read as
  // "no lock": compile never writes one (export creates it at that path), so a
  // mistyped path would silently hand out name-derived guids the workspace's
  // locked bundle does not use.
  if (args.lockPath !== undefined && !existsSync(lockPath)) {
    throw new UsageError(
      `compile: no lock file at ${displayPath(lockPath)}. \`compile\` reads the lock and never writes one — ` +
        `point \`--lock\` at the xano.lock \`xanosdk export\` wrote, or drop it to use the nearest one.`,
      { hintFor: { command: "compile" } },
    );
  }
  // Always reset before (maybe) seeding: a run in a process that previously
  // seeded a different lock must not inherit its stale overrides.
  resetLockOverrides();
  // Seed from an adjacent lock so a single-function artifact carries the same
  // reference guids a locked bundle would. Compile never writes the lock.
  if (existsSync(lockPath)) {
    seedLockOverrides(readLockFile(lockPath));
  }
  const mod = await loadModule(file);
  const namedDefs = (): [string, unknown][] =>
    Object.entries(mod).filter(
      ([key, value]) =>
        key !== "default" &&
        value !== null &&
        typeof value === "object" &&
        !Xano.isXano(value) &&
        typeof (value as { name?: unknown }).name === "string",
    );
  if (args.exportName !== undefined && !Object.hasOwn(mod, args.exportName)) {
    const names = namedDefs().map(([key]) => `\`${key}\``);
    throw new UsageError(
      `Module "${file}" has no export \`${args.exportName}\`.` +
        (names.length > 0 ? ` Its named defs: ${names.join(", ")}.` : ""),
      { hintFor: { command: "compile" } },
    );
  }
  let def: unknown = args.exportName !== undefined ? mod[args.exportName] : mod.default;
  // A generated tree (`init --from`, `pull`, `generate`) exports each def BY
  // NAME, never as default — `compile` over one of its files used to fail with
  // "no default export" every time. One named def is the one to compile; more
  // than one is refused by name, since picking would be a guess.
  if (def === undefined && args.exportName === undefined) {
    const named = namedDefs();
    if (named.length === 1) {
      def = named[0]![1];
      info(`Compiling the named export \`${named[0]![0]}\` (the module has no default export).`);
    } else if (named.length > 1) {
      throw new UsageError(
        `Module "${file}" has no default export and ${named.length} named defs — ` +
          `${named.map(([key]) => `\`${key}\``).join(", ")} — so \`compile\`, which takes one def, ` +
          `cannot tell which to compile. Name one: \`xanosdk compile ${shellWord(file)} --export ${named[0]![0]}\`, ` +
          `or export the workspace with \`xanosdk export\`.`,
        { hintFor: { command: "compile" } },
      );
    }
  }
  // A workspace registry is the single most likely thing to arrive here: it is
  // what `xanosdk init` scaffolds, and `compile` is the first command listed
  // under Author. Naming it specifically is what keeps the failure from reading
  // as "my entry file is malformed" and sending someone to edit correct code.
  // Both refusals below are the wrong file for this command — usage errors,
  // like the several-named-defs one above.
  if (Xano.isXano(def)) {
    throw new UsageError(
      `Module "${file}" default-exports a workspace — use \`xanosdk export\` (or ` +
        `\`xanosdk routes\`) for a workspace entry. \`compile\` takes a single object ` +
        `def (a query, function, table, …) and prints its JSON artifact.`,
      { hintFor: { command: "compile" } },
    );
  }
  if (!def || typeof def !== "object" || typeof (def as FunctionDef).name !== "string") {
    // Deliberately does not name the internal type: `FunctionDef (got: object)`
    // told the reader nothing actionable, and a workspace IS an object.
    throw new UsageError(
      `Module "${file}" must default-export a single object def (a query, function, ` +
        `table, …) — one object with a \`name\`. Got: ${describeDefaultExport(def)}.`,
      { hintFor: { command: "compile" } },
    );
  }
  const one = def as { name: string; guid?: unknown };
  // Encoded by the SDK copy that BUILT the def — see `emitterFor`. Its encoder
  // warnings are collected, for the checks below to raise as export would.
  const encode = await emitterFor(file);
  // A project's own copy judges its own defs; this copy refuses one it cannot
  // place as a usage error rather than letting `emit` throw.
  if (encode === emit && standaloneDefKind(one) === undefined) throw unplaceableDef(file, one.name);
  const raised: Diagnostic[] = [];
  const previousSink = setDiagnosticSink((d) => raised.push(d));
  // The fills an export applies that one def can take: hosted-file icons, read
  // here as export reads them, and a group's documentation token from the
  // project's secrets file (beside the lock, where the backend's files sit).
  const docTokens = Object.create(null) as Record<string, string>;
  for (const [key, entry] of Object.entries(readSecretsFile(join(dirname(lockPath), ".secrets.json"))?.documentationTokens ?? {})) {
    docTokens[key] = entry.value;
  }
  let artifact: string;
  try {
    artifact = withPinnedGuid(encode(one, { hostedFiles: hostedFileResolver(), documentationTokens: docTokens }), one);
  } catch (err) {
    // A project's own SDK copy refuses an unplaceable def with a plain error;
    // said here as this copy says it, so both copies give one result.
    if (encode !== emit && err instanceof Error && /cannot tell what kind of def/.test(err.message)) {
      throw unplaceableDef(file, one.name);
    }
    throw err;
  } finally {
    setDiagnosticSink(previousSink);
  }
  // A knowledge body is read here, as the bundle path reads it, so the printed
  // entry carries the markdown an export would send.
  if (standaloneDefKind(one) === "knowledge") artifact = withKnowledgeContent(artifact, one as KnowledgeDef, raised);
  const parsedArtifact = JSON.parse(artifact) as { documentation?: unknown };
  const gate = (one as { documentation?: { require_token?: unknown } }).documentation;
  if (standaloneDefKind(one) === "api_group" && gate?.require_token === true && parsedArtifact.documentation === undefined) {
    raised.push({
      severity: "warning",
      code: "doc-token.unsupplied",
      message: `API group "${one.name}" declares a documentation gate and no token was found for it in ` +
        `\`${displayPath(join(dirname(lockPath), ".secrets.json"))}\`, so this artifact carries no \`documentation\` block — ` +
        `the bytes an export would write CLEAR the group's gate. \`xanosdk pull\` stores the token there.`,
    });
  }
  // The per-def export checks, so a def `export` would warn about (or refuse
  // under `--strict`) does not compile clean.
  checkCompiledDef(one, artifact, args.strict === true, raised);
  if (args.out && args.out !== "-") {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(args.out, artifact + "\n", "utf8");
    reportWrote(args, args.out);
  } else {
    writeData(process.stdout, artifact + "\n");
  }
}

/** A compiled knowledge entry with its body read off disk, as an export fills it. */
function withKnowledgeContent(artifact: string, def: KnowledgeDef, raised: Diagnostic[]): string {
  const [resolved] = resolveKnowledge([def]);
  if (resolved === undefined) return artifact;
  for (const w of resolved.warnings ?? []) raised.push({ severity: "warning", code: w.code, message: w.message });
  return JSON.stringify({ ...(JSON.parse(artifact) as Record<string, unknown>), content: resolved.content }, null, 2);
}

/** `compile`'s refusal for a def nothing marks as a kind. */
function unplaceableDef(file: string, name: string): UsageError {
  return new UsageError(
    `Module "${file}" exports "${name}", which nothing marks as a kind of def — no factory brand, ` +
      `no \`verb\`, \`schema\` or group key — so \`compile\` cannot tell which encoder to use. Build it with its ` +
      `factory (\`defineFunction({...})\`, \`table({...})\`, \`task({...})\`, …) rather than as an object literal or a spread copy.`,
    { hintFor: { command: "compile" } },
  );
}

/**
 * The artifact with the def's pinned `guid`, where the export writes it (last).
 * The encoder leaves identity to the registry, so a `guid` the author wrote —
 * the one thing that says which deployed object this is — was missing here.
 */
function withPinnedGuid(artifact: string, def: { guid?: unknown }): string {
  if (typeof def.guid !== "string" || def.guid === "") return artifact;
  const parsed = JSON.parse(artifact) as Record<string, unknown>;
  if (parsed.guid !== undefined) return artifact;
  return JSON.stringify({ ...parsed, guid: def.guid }, null, 2);
}

/**
 * `xanosdk routes <entry>` (alias `paths`) — list every API query's HTTP verb
 * and its resolved group-relative path in the `api:<canonical>/<name>` form, so
 * writing a frontend client or curling a live env doesn't need a hand-rolled
 * script. Read-only: it seeds an existing `xano.lock` to resolve
 * canonicals (the same source `getPath()` uses) but never mints or writes one —
 * a group with no resolvable canonical is reported with the same fix `getPath()`
 * points to. Reconstructs the path from the exported bundle (`payload.query[]`
 * joined to `payload.app[]` by guid) rather than the `getPath()` handle, which
 * the registry discards at `register()`.
 */
async function runPaths(args: ParsedArgs): Promise<void> {
  const file = args.file!;
  // `--emit -` writes the module to stdout — never a file named `-`. There is
  // then no committed file for `--strict` to compare against.
  if (args.emit === "-" && args.strict) {
    throw new UsageError(
      "`--strict` checks a committed route manifest, and `--emit -` writes to stdout — name the file " +
        "it should check: `--emit <path> --strict`.",
      { hintFor: { command: "routes" } },
    );
  }
  const lockPath = resolveLockPath(args, file);
  // Read an existing lock to resolve canonicals READ-ONLY, mirroring
  // getPath()/resolveCanonical (in-code canonical → locked-by-name → unresolved).
  // Deliberately export WITHOUT a lock context: that path MINTS a fresh random
  // canonical for any group the lock doesn't yet know (applyLock), which `paths`
  // would then print as a resolved URL even though it's ephemeral and unpersisted
  // — a token that would differ from the one a real `export --lock` freezes.
  // `paths` never mints or writes. resetLockOverrides clears any stale seed a
  // prior in-process command left, so reference guids bake consistently.
  resetLockOverrides();
  const lockModel = existsSync(lockPath) ? readLockFile(lockPath) : undefined;

  const def = await loadDefault(file);
  if (!Xano.isXano(def)) {
    throw new UsageError(
      `Module "${file}" must default-export a Xano registry for \`${commandLabel(args)}\` — ` +
        `\`export default workspace("…")…\`. Got: ${describeDefaultExport(def)}.`,
    );
  }
  // `export()` REFUSES a declared documentation gate it cannot supply, because
  // the bytes it would otherwise sign clear a live one. This command signs
  // nothing: it prints a listing, and a token decides nothing about a URL. So
  // every declared scope gets a stand-in value and no secrets file is read —
  // the listing works on a fresh clone with no `xano/.secrets.json`, which is
  // where the scaffolded `xano:check` runs in CI. See `checkStandInTokens`.
  // The token FLAGS are refused on this command at parse time, for the same
  // reason: a value they supplied would change nothing either.
  // The early-surface notice is `export`'s to give: `routes --emit` runs before
  // every `dev`, `build` and `typecheck`, where repeating it trains it away.
  const outerSink = setDiagnosticSink((d) => {
    if (d.code !== "microservice.early-surface") outerSink(d);
  });
  let bundle: ReturnType<typeof def.export>;
  try {
    bundle = def.export({ strict: args.strict, documentationTokens: checkStandInTokens(def).values });
  } finally {
    setDiagnosticSink(outerSink);
  }
  const payload = bundle.payload as Record<string, unknown>;
  const { planRouteManifest } = await import("./routes-manifest.js");
  // The one reading of a payload the decode paths share, so a manifest a pull
  // wrote is byte-identical to the one this command would emit for it.
  const plan = planRouteManifest(payload, (kind, name) => lockModel?.objects[lockKey(kind, name)]?.canonical);
  const queryCount = plan.rows.length;
  const realtimeCount = plan.servers.length + plan.unresolvedServers.length;

  // A realtime-only workspace has no routes to print but still has a manifest
  // worth emitting (its socket addresses), so only the printing path is empty.
  // Under machine output the answer is a document, never a silence or a line of
  // prose: `{ routes: [...] }` for the listing, `{ emit, written, ... }` for `--emit`.
  const machine = isMachineOutput(args);
  // A committed manifest that still lists routes the workspace no longer has is
  // stale even though there is nothing left to list: `--strict` fails on it and
  // `--emit` rewrites it to the empty manifest, so a call site reaching for a
  // removed endpoint stops compiling instead of addressing a 404.
  const emptiedManifest =
    args.emit !== undefined && queryCount === 0 && realtimeCount === 0 && existsSync(args.emit);
  if (queryCount === 0 && !(args.emit !== undefined && realtimeCount > 0) && !emptiedManifest) {
    info("No API queries registered in this workspace.");
    if (machine && args.emit !== "-") writeJson(args.emit !== undefined ? { emit: resolve(args.emit), written: false, routes: 0, channels: 0 } : { routes: [] });
    return;
  }

  const unresolved = plan.unresolved;
  const resolved = plan.resolved;

  // `--emit` writes the generated route module instead of printing. It needs
  // every canonical resolved, so the unresolved check below runs first — a
  // manifest missing routes is worse than no manifest, because the gap is
  // invisible until a call site reaches for a name that isn't there.
  if (args.emit !== undefined) {
    // An unresolved REALTIME server is a warning, not a failure — deliberately
    // unlike an unresolved api group above. A manifest missing a route is worse
    // than no manifest because routes are what the file is for; a workspace that
    // merely CONTAINS realtime should still get its HTTP half, and a socket
    // address nobody could resolve is better left out than guessed at. What is
    // dropped is named, and reaching for a dropped server or channel is a
    // compile error at the call site, never a wrong address at runtime.
    const unresolvedServers = plan.unresolvedServers.map((name) => ({ name }));
    const describableServers = plan.servers;
    const channelRows = plan.channels;
    if (unresolvedServers.length > 0) {
      warn(
        `${args.emit}: leaving out ${countOf(unresolvedServers.length, "realtime server")} — ` +
          `${unresolvedServers.map((s) => `"${s.name}"`).join(", ")} — whose canonical URL token ` +
          `resolves nowhere, along with their channels. Set an explicit ` +
          `\`realtimeServer({ canonical })\`, or run \`xanosdk export ${shellWord(file)} --out ${NULL_DEVICE}\` once ` +
          `(it mints a unique canonical and freezes it in xano.lock, and writes the bundle nowhere), then re-run to include them.`,
        "routes.realtime-unresolved",
      );
    }

    // An unresolved api group writes nothing (a manifest missing a route is
    // worse than none) and is never silent: `--strict` (the scaffold's
    // `xano:check`) fails on it, and a plain `--emit` (every `dev`, `build`,
    // `typecheck`) warns with the fix and exits 0, so a project that has not
    // exported yet still starts.
    if (unresolved.length > 0) {
      const { unresolvedCanonicalMessage } = await import("./routes-manifest.js");
      const why = `${args.emit} was not written: ${unresolvedCanonicalMessage(unresolved, shellWord(file))}`;
      if (args.strict) throw new Error(`--strict: ${why}`);
      warn(why, "routes.not-written");
      if (machine && args.emit !== "-") writeJson({ emit: resolve(args.emit), written: false, routes: 0, channels: 0 });
      return;
    }

    if (resolved.length === 0 && describableServers.length === 0 && !emptiedManifest) {
      // Everything was dropped by the warnings above; a file exporting nothing
      // is worse than none, and the warnings already say what to fix.
      info(`Nothing to write to ${args.emit} yet.`);
      if (machine && args.emit !== "-") writeJson({ emit: resolve(args.emit), written: false, routes: 0, channels: 0 });
      return;
    }

    const { renderPlannedManifest, renderRouteManifest } = await import("./routes-manifest.js");
    const source = emptiedManifest ? renderRouteManifest([]) : renderPlannedManifest(plan)!;
    const routeCount = resolved.length === 1 ? "1 route" : `${resolved.length} routes`;
    const channelCount =
      channelRows.length === 1 ? "1 channel" : `${channelRows.length} channels`;
    const count = describableServers.length > 0 ? `${routeCount}, ${channelCount}` : routeCount;
    // `--emit -` is stdout, as `export` and `workspace export --path -` spell
    // it: the module IS the output, so no summary document follows it.
    if (args.emit === "-") {
      writeData(process.stdout, source);
      return;
    }
    // A CLI of another version than the project's installed SDK renders the
    // table in its own words: the file is left to the installed CLI, which the project's own
    // `xano:check` runs, rather than rewritten into what that check calls stale.
    // The project is the one the table is written INTO — its check is the one
    // that compares it — wherever the command was typed from and wherever the
    // entry lives; the entry's project only when the target is in none. One
    // owner, so the remedy runs a CLI that agrees with it and never points back.
    const { installedSdk, skewedProjectSdk, skewNote, installedCliCommand } = await import("./project-sdk.js");
    const emitDir = dirname(resolve(args.emit));
    const projectSdk = skewedProjectSdk(installedSdk(emitDir) !== undefined ? emitDir : dirname(resolve(file)), readVersion());
    if (projectSdk !== undefined && existsSync(args.emit) && readFileSync(args.emit, "utf8") !== source) {
      const emit = args.emit;
      const installed = installedCliCommand(
        projectSdk.root,
        (path) => `routes ${path(file)} --emit ${path(emit)}${args.strict ? " --strict" : ""}`,
      );
      // `--strict` is the CI guard, and this CLI cannot tell a stale table from
      // one in the installed version's words: it fails rather than pass either.
      if (args.strict) {
        throw new CliError(
          DRIFT,
          `--strict: ${displayPath(emit)} differs from what this CLI (@xano/sdk ${readVersion()}) renders, and the ` +
            `project has ${projectSdk.version} installed, whose wording the table follows — so this CLI cannot tell a ` +
            `stale table from a current one. Run \`${installed}\` to check it with the installed CLI.`,
        );
      }
      warn(skewNote(emit, readVersion(), projectSdk.version, installed), "routes.cli-skew");
      if (machine) writeJson({ emit: resolve(emit), written: false, routes: resolved.length, channels: 0 });
      return;
    }
    // `--check` is the CI guard. A generated manifest that is never
    // regenerated rots exactly like the hand-typed ROUTES table it replaces —
    // the strings keep compiling while the backend has moved.
    if (args.strict) {
      const current = existsSync(args.emit) ? readFileSync(args.emit, "utf8") : undefined;
      if (current !== source) {
        // A committed artifact out of date: the same code `export --check`
        // and `--frozen-lock` give a stale lock. The scaffold's own script is
        // named when the project has one, since that is the command its
        // README and agent brief teach.
        throw new CliError(
          DRIFT,
          `--strict: ${args.emit} is ${current === undefined ? "missing" : "out of date"}. ` +
            `Run ${routesRegenerateCommand(file, args.emit)} and commit the result — ` +
            `a stale route manifest keeps compiling while the endpoints have moved.`,
        );
      }
      info(`${args.emit} is up to date (${count}).`);
    }
    // Identical bytes are not rewritten: a no-op regeneration must not bump
    // the file's mtime (watchers, build caches) nor claim a write it did not make.
    let written = false;
    if (!args.strict) {
      const current = existsSync(args.emit) ? readFileSync(args.emit, "utf8") : undefined;
      if (current === source) {
        info(`${args.emit} is already up to date (${count}).`);
      } else {
        try {
          mkdirSync(dirname(resolve(args.emit)), { recursive: true });
          writeFileSync(args.emit, source, "utf8");
        } catch (err) {
          if (isUnwritableError(err)) throw unwritableError(args.emit, "pass `--emit` a path you can write");
          throw err;
        }
        written = true;
        info(`Wrote ${args.emit} (${count}).`);
      }
    }
    if (machine) {
      writeJson({
        emit: resolve(args.emit),
        written,
        routes: resolved.length,
        channels: describableServers.length > 0 ? channelRows.length : 0,
      });
    }
  } else if (machine) {
    // Nothing is written while a route is unresolved: the throw below becomes the
    // failure document, and a half listing beside it would be a second one.
    if (unresolved.length === 0) {
      writeJson({
        routes: resolved.map((r) => ({
          verb: r.verb,
          path: `/api:${r.canonical}/${r.name}`,
          ref: `api:${r.canonical}/${r.name}`,
        })),
      });
    }
  } else {
    const verbWidth = Math.max(0, ...resolved.map((r) => r.verb.length));
    for (const r of resolved) {
      const path = `/api:${r.canonical}/${r.name}`;
      // Requested output → stdout (a caller may pipe it). Verb-padded for scanning;
      // the trailing `api:<canonical>/<name>` is the canonical string form.
      process.stdout.write(`${r.verb.padEnd(verbWidth)}  ${path}  api:${r.canonical}/${r.name}\n`);
    }
  }

  if (unresolved.length > 0) {
    const { unresolvedCanonicalMessage } = await import("./routes-manifest.js");
    throw new UsageError(`${commandLabel(args)}: ${unresolvedCanonicalMessage(unresolved, shellWord(file))}`);
  }
}

/**
 * Bring an existing route manifest up to date with the workspace, quietly —
 * for a command that changed the workspace as a side effect (`marketplace
 * remove` taking a module's endpoints with it) and must not leave the committed
 * file listing routes that are gone. The same reading `routes --emit` makes,
 * without its output. Also counts the lock entries the workspace no longer
 * exports, which the same change orphans.
 *
 * "skipped" when the manifest cannot be brought up to date here (an api group
 * whose canonical resolves nowhere), which the caller reports with the command.
 */
export async function refreshRouteManifest(
  entry: string,
  emit: string,
): Promise<{ manifest: "written" | "unchanged" | "skipped" | "absent"; lockOrphans: number }> {
  resetLockOverrides();
  const lockPath = join(dirname(resolve(entry)), "xano.lock");
  const lockModel = existsSync(lockPath) ? readLockFile(lockPath) : undefined;
  const def = await loadDefault(entry);
  if (!Xano.isXano(def)) return { manifest: "absent", lockOrphans: 0 };
  const previousSink = setDiagnosticSink(() => {});
  let payload: Record<string, unknown>;
  try {
    payload = def.export({ documentationTokens: checkStandInTokens(def).values }).payload as Record<string, unknown>;
  } finally {
    setDiagnosticSink(previousSink);
  }
  const { pulledIdentities } = await import("./pull-command.js");
  const live = pulledIdentities(payload);
  const lockOrphans =
    lockModel === undefined ? 0 : Object.keys(lockModel.objects).filter((k) => k !== WORKSPACE_KEY && !live.has(k)).length;
  if (!existsSync(emit)) return { manifest: "absent", lockOrphans };
  const { planRouteManifest, renderPlannedManifest, renderRouteManifest } = await import("./routes-manifest.js");
  const plan = planRouteManifest(payload, (kind, name) => lockModel?.objects[lockKey(kind, name)]?.canonical);
  if (plan.unresolved.length > 0) return { manifest: "skipped", lockOrphans };
  const source =
    renderPlannedManifest(plan) ??
    (plan.resolved.length === 0 && plan.servers.length === 0 ? renderRouteManifest([]) : undefined);
  if (source === undefined) return { manifest: "skipped", lockOrphans };
  if (readFileSync(emit, "utf8") === source) return { manifest: "unchanged", lockOrphans };
  try {
    writeFileSync(emit, source, "utf8");
  } catch (err) {
    if (isUnwritableError(err)) throw unwritableError(emit);
    throw err;
  }
  return { manifest: "written", lockOrphans };
}

/**
 * The command that regenerates a route manifest, as the reader should type it:
 * `npm run xano:routes` in a scaffolded project whose script writes exactly this
 * file, the bare CLI call otherwise.
 */
function routesRegenerateCommand(file: string, emit: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const script = pkg.scripts?.["xano:routes"];
    if (typeof script === "string" && script.includes(`--emit ${emit}`)) return "`npm run xano:routes`";
  } catch {
    // No readable package.json here: the bare command below is the answer.
  }
  return `\`xanosdk routes ${shellWord(file)} --emit ${shellWord(emit)}\``;
}

/** A compiled bundle plus any seed `content/` entries (empty unless requested). */
export interface CompiledBundle {
  bundle: string;
  /** The same bundle before serialization, for a consumer that renders rather than writes it. */
  bundleObject: Bundle;
  content: SeedContentFile[];
  /**
   * The bytes of every `hostedFile(...)` the bundle references, as `vault/`
   * archive members. Always built: the bundle's file library lists them, so an
   * archive without them cannot land.
   */
  files: ArchiveEntry[];
  /**
   * Names of tables that declared `seed` but whose rows were NOT built into
   * `content` (i.e. `opts.seed` was false). Empty when `opts.seed` is true. Lets
   * the `export` command warn that its artifact omits seed — so the CI pattern
   * `export --out bundle.json` then `deploy --bundle bundle.json` doesn't drop
   * seed silently (a `--bundle` deploy has no registry to resolve seed from).
   */
  omittedSeedTables: string[];
  /**
   * Seed values drawn from columns the schema declares non-public, for the
   * `--static` publication guard. Empty unless seed was resolved.
   */
  nonPublicSeedValues: NonPublicSeedValue[];
  /**
   * The lock this compile maintained — its path as the CLI names it, and whether
   * this run changed it on disk — or null for a `--no-lock` build.
   */
  lock: { path: string; changed: boolean } | null;
  /** The build warnings this compile printed, for a `--json` document to carry. */
  warnings: Array<{ code: string; message: string }>;
  /**
   * The env names the SOURCE declares (`workspaceConfig({ env })`) — not the
   * bundle's, which also carries names `--env-var` or `--backend-env-file`
   * added for this one build. What a committed `.env.example` lists.
   */
  declaredEnvNames: string[];
  /**
   * The lock as THIS compile classified it — the merged model, whether or not
   * it has been written yet. Absent for a `--no-lock` build.
   *
   * What a release pins is read from here, not from the file: a deferred write
   * (`deferLockWrite`) or a read-only run (`lockReadOnly`, a dry run) leaves
   * the file one export behind, and a `canonical` the code names on an object
   * new to it would otherwise ride the first release as a preference.
   */
  classifiedLock?: LockFile;
  /**
   * Present only when the compile was asked to defer its lock write
   * (`deferLockWrite`) and there is one to make: writes the lock and says so.
   * The caller runs it once its own pre-write refusals have passed, so a
   * refused run leaves `xano.lock` untouched.
   */
  commitLock?: (opts?: CommitLockOptions) => void;
  /**
   * Present only when the compile was asked to defer its orphan warning
   * (`deferOrphanWarning`): says it, once, leaving out the keys a `--prune` the
   * caller has since planned deletes. A dry run writes no lock, so this is how
   * its preview drops the "renamed? / deleted?" fix-ups for them (E2E pass 25).
   */
  warnLockOrphans?: (pruned?: ReadonlySet<string>) => void;
  /**
   * Present beside {@link commitLock}: says the orphan warning the deferred
   * write would have said, for a run refused before it — the "renamed? / deleted?"
   * fix-ups are as true of a refused deploy as of an export. Once: the write
   * that follows does not repeat it.
   */
  warnOrphansUncommitted?: () => void;
}

/** What a deferring caller knows by the time it commits the lock. */
export interface CommitLockOptions {
  /**
   * Lock keys a confirmed `--prune` is about to delete. Their entries match no
   * exported object BECAUSE the project deleted them, so the orphan warning's
   * "renamed? / deleted?" fix-ups are not said for them.
   */
  readonly pruned?: ReadonlySet<string>;
  /**
   * The destination as it resolved, when that says more than `--to` did: a
   * `tenant:<handle>` that is an ephemeral is `ephemeral:<handle>`, so a new
   * lock's adopt pointer names the export that reads one (E2E pass 26).
   */
  readonly to?: string;
  /**
   * The run's plan only created, and met no conflict: the destination held
   * nothing of this project's to adopt, so a new lock says no adopt pointer
   * (E2E pass 28: a first `--to` deploy that only created still said it).
   */
  readonly nothingToAdopt?: boolean;
}

/**
 * Thin wrapper over {@link compileBundle} for the many callers that only need the
 * bundle text (export, preflight). Seed content is not built here.
 *
 * Exported from `@xano/sdk/node`, so this is a PUBLIC surface and it inherits
 * the default: calling it writes and maintains `xano.lock` beside the entry
 * file, and it can fail for the reasons a locked build fails (an unwritable
 * directory, a lock that does not parse). That is deliberate — the default is
 * about what compiling an entry file means, not about which process asked — but
 * a programmatic caller that wants bytes and nothing else should pass
 * `--no-lock` through its `ParsedArgs`.
 */
export async function exportBundleJson(args: ParsedArgs): Promise<string> {
  return (await compileBundle(args)).bundle;
}

/**
 * Compile an entry file to its `packageExport` bundle, running the full lock
 * pipeline (seed → export → write). With `opts.seed`, also resolve + validate the
 * tables' seed rows into signed `content/` archive entries — done HERE, inside the
 * same lock-seeded context as the export, so a seed file's `dbo` guid matches the
 * table's guid in `workspace.json`. Only the deploy path passes `seed:true`, so a
 * plain `export`/`validate` never resolves seed sources.
 */
export async function compileBundle(
  args: ParsedArgs,
  opts: { seed?: boolean; deferLockWrite?: boolean; deferOrphanWarning?: boolean } = {},
): Promise<CompiledBundle> {
  const file = args.file!;
  // Resolve the lock BEFORE importing the workspace module: references bake
  // guids the moment defs are evaluated, so seeding must come first. An invalid
  // lock is a hard error here — never degrade to a silent unlocked run.
  const lockPath = resolveLockPath(args, file);
  const lockExists = existsSync(lockPath);
  // Always reset before (maybe) seeding: an unlocked run in a process that
  // previously seeded a different lock must not inherit its stale overrides.
  resetLockOverrides();

  let lockCtx: LockExportContext | undefined;
  let originalSerialized: string | undefined;
  // Legacy ephemeral landing records the load dropped (see `parseLockReport`).
  // The file on disk still holds them, so the lock this run would write differs
  // from it even when the identities do not — a change `--check` must report
  // and a plain export must announce.
  let droppedLandings: string[] = [];
  // Every export-time warning the CLI itself prints goes through `exportWarn`,
  // which records it here under `--strict` — see `failStrictFindings`.
  strictFindings = args.strict ? [] : undefined;
  exportFindings = [];
  let lockReport: CompiledBundle["lock"] = null;
  let commitLock: ((opts?: CommitLockOptions) => void) | undefined;
  let deferredOrphans: ((pruned?: ReadonlySet<string>) => void) | undefined;
  let uncommittedOrphans: (() => void) | undefined;
  let classifiedLock: LockFile | undefined;
  if (args.noLock) {
    // `--no-lock` over a lock the project committed is refused, not honored.
    // The other contradictions are between flags and are caught at parse time;
    // this one is between a flag and the working tree, and it is the dangerous
    // one: without the lock, guids fall back to name derivation, so every
    // object the lock pins under a different guid would be DELETED and
    // recreated by whatever this bundle is released to — reported as success.
    //
    // Keyed on PARSEABLE, not on the file existing. A corrupt lock is a file
    // that exists, and `--no-lock` is the recovery its own error names; keying
    // on existence would have this check refuse the escape hatch it points at.
    if (lockExists && isParseableLock(lockPath)) {
      // A check writes and syncs nothing, so what an unlocked BUILD would do
      // to a backend is not its story (E2E pass 30): it would only check less
      // than the lock the project committed.
      if (args.command === "export" && args.check) {
        throw new UsageError(
          `\`--no-lock\` refused: ${displayPath(lockPath)} exists, and a check without it would skip the ` +
            `identities it pins. Drop \`--no-lock\`: \`xanosdk export ${shellWord(pastePath(args.file ?? ""))} --check\` ` +
            `checks them too.`,
        );
      }
      // A flag that contradicts the working tree: fixed by retyping, so usage.
      throw new UsageError(
        `\`--no-lock\` refused: ${displayPath(lockPath)} exists and pins ` +
          `this project's identities.\nBuilding without it derives guids from names instead, so ` +
          `every object the lock pins under a different guid is deleted and recreated by whatever ` +
          `this bundle is released to.\nDrop \`--no-lock\` to build against the lock, or delete ` +
          `the lock first if you really mean to abandon those identities.`,
      );
    }
    // A check builds nothing to sync, so the notice about what an unlocked bundle does is not its to say.
    // A missing entry is refused first: the notice confirms a build that is not going to happen.
    assertEntryExists(file);
    if (!(args.command === "export" && args.check)) noteUnlockedBuild();
  } else {
    const loaded = lockExists ? readLockFileReport(lockPath) : { lock: emptyLock(), droppedLandings: [] };
    const lockModel = loaded.lock;
    droppedLandings = loaded.droppedLandings;
    if (lockExists) originalSerialized = serializeLock(lockModel);
    seedLockOverrides(lockModel);
    lockCtx = createLockContext(lockModel);
  }

  // Build warnings raised while the entry EVALUATES — `c.obj({"0": …})` warns
  // when the call runs, at module load — reach the sink, not the export's
  // diagnostic bag, so `--strict` never saw them. Record every warning the sink
  // passes through from here to the end of `export()` and fail the build on
  // them below. Under `--strict` the bag's own warnings
  // are thrown rather than sunk, so nothing is counted twice.
  const buildWarnings: Diagnostic[] = [];
  const previousSink = setDiagnosticSink((diagnostic) => {
    if (diagnostic.severity === "warning") buildWarnings.push(diagnostic);
    // Under `--strict` it is reported once, in the refusal below.
    if (!(args.strict && diagnostic.severity === "warning")) {
      previousSink(diagnostic);
      // Printed, so every `--json` document this run writes carries it under its
      // own code — `deploy`, `release create` and `publish` as well as `export`.
      if (diagnostic.severity === "warning") noteRunWarning(diagnostic.code, diagnostic.message, diagnostic.subject);
    }
  });
  const checkOnly = args.command === "export" && args.check;
  // What each def's `diagnostics.allow` accepted — never printed, but carried by
  // the run's `--json` documents as `accepted[]`.
  const accepted: Diagnostic[] = [];
  let def: Xano | undefined;
  let bundle: ReturnType<Xano["export"]> | undefined;
  // The export's own `--strict` refusal, held so the CLI's findings join it.
  let libraryRefusal: DiagnosticError | undefined;
  // Every hosted file the shipped bundle references; read inside the export below.
  const hostedFiles = hostedFileResolver();
  // The same export, unsigned and unlocked, for the checks run on a refused build.
  let exportForChecks: (() => ReturnType<Xano["export"]>) | undefined;
  try {
    const loaded = await loadDefault(file);
    if (!Xano.isXano(loaded)) {
      // Named by the command that was run — `deploy`, `preflight`, `release
      // create` all compile through here, and "for `export`" sent a deploy's
      // reader to a command they never typed.
      throw new UsageError(
        `Module "${file}" must default-export a Xano registry for \`${commandLabel(args)}\` — ` +
          `\`export default workspace("…")…\`. Got: ${describeDefaultExport(loaded)}.`,
      );
    }
    def = loaded;
    // A seeded row's hosted files join the payload's file library, which is
    // signed below, so they are read before the export — only when the rows ship.
    if (opts.seed) await registerSeedHostedFiles(loaded.tables(), hostedFiles, loaded.workspaceSettings().use_xdo === true);
    // `--strict` also promotes every build warning to a hard failure:
    // the shapes that export clean and then lose data or return the wrong rows.
    // Knowledge bodies are read here, not in `export()`: they ride inside the
    // payload and so must be present before the bundle is signed, and the read
    // needs `node:fs` that the browser-safe export path must not carry. Every
    // command that produces a bundle runs through here, so `xanosdk export` writes
    // the same bytes a deploy sends.
    const resolvedKnowledge = resolveKnowledge(def.knowledge());
    // Deploy-time backend secrets. Merged INSIDE export() — the bundle is signed,
    // so a later patch invalidates the signature — which is why they are resolved
    // here rather than applied to the finished bytes.
    //
    // Precedence, highest first: `--env-var KEY=VALUE`, then an explicit
    // `--backend-env-file <path>` OR the default `xano/.env` — never both. An explicit
    // file REPLACES the default rather than layering over it: pointing at a CI
    // secret mount must not also ship a developer's local file.
    //
    // `export --check` reads neither. It signs nothing and writes nothing, so no
    // value it could be missing clears anything anywhere — and a CI checkout has
    // neither file. Every declared documentation scope gets a stand-in instead,
    // so the guards see a gate as a gate (no false "publicly readable"), and the
    // stand-in never leaves this process. Identities do not depend on either
    // value, so the lock verdict is the one a real export reaches.
    const envOverrides = checkOnly ? {} : resolveWorkspaceEnv(args, file, def.workspaceSettings());
    // Documentation tokens, from `xano/.secrets.json` rather than from `xano/.env`
    // — a secret addressed by an object's identity, not by a name. Resolved here
    // for the same reason the backend values are: `export()` merges them before
    // signing, so they cannot be patched into finished bytes.
    const docTokens = checkOnly ? checkStandInTokens(def) : resolveDocumentationTokens(args, file, def);
    // Hosted files are read here for the same reason knowledge bodies are: the
    // file-library rows and each field's placeholder ride inside the signed
    // payload, and the read needs `node:fs`. A fresh resolver per export, so
    // the check rebuild below cannot double-count references.
    const exportOptions = {
      knowledge: resolvedKnowledge,
      ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
      documentationTokens: docTokens.values,
      allowEmptyDocToken: docTokens.allowEmpty,
      secretsRemedy: secretsRemedyFor(file),
    };
    const built = def;
    exportForChecks = () => built.export({ ...exportOptions, hostedFiles: hostedFileResolver() });
    bundle = def.export({ ...(lockCtx ? { lock: lockCtx } : {}), strict: args.strict, ...exportOptions, hostedFiles, accepted });
  } catch (err) {
    // The export's own bag failed. Under `--strict` the rest of the findings —
    // warnings the entry raised while it loaded, the CLI's own (workspace env,
    // filter names) — are failures too: ONE refusal names every one of them,
    // instead of the next run surfacing the ones this throw skipped.
    if (!(args.strict && isDiagnosticError(err))) throw err;
    libraryRefusal = err;
  } finally {
    setDiagnosticSink(previousSink);
    // Filled even when the export refused: a `--json` failure carries them too.
    noteRunAccepted(accepted);
  }
  // The CLI's own export-time warnings — documentation gates, workspace env,
  // filter names the engine cannot resolve — fail `--strict` as the library's
  // do, before anything (the lock included) is written. A refused build is
  // still checked: rebuilt without `strict`, silently, only to be read.
  checkFilterNames(bundle ?? quietly(exportForChecks));
  const library = [...buildWarnings, ...(libraryRefusal?.details ?? [])];
  if (args.strict && library.some((d) => d.severity === "warning")) failStrictFindings(args, library);
  if (libraryRefusal !== undefined) throw libraryRefusal;
  failStrictFindings(args);
  if (bundle === undefined || def === undefined) throw new Error("unreachable: no bundle and no refusal");
  // A literal `xanosdk-file://…` icon src (copied out of a bundle) names bytes no
  // `hostedFile()` in this project reads, so nothing could ever ship them — the
  // deploy would refuse it, and redeploying from the entry changes nothing.
  const literalIcons = uncarriedHostedIcons(
    ((bundle as { payload?: Record<string, unknown> }).payload ?? {}),
    new Set(hostedFiles.files().map((f) => f.canonical)),
  );
  if (literalIcons.length > 0) {
    throw new UsageError(
      `${countOf(literalIcons.length, "icon")} name${literalIcons.length === 1 ? "s" : ""} a hosted file by a literal ` +
        `\`xanosdk-file://\` src, which carries no bytes — a bundle's placeholder copied into source:\n` +
        literalIcons
          .map((i) => `  ${i.owner} \`icons[${i.index}]\`: save the image as ${i.name} beside its module and write \`src: hostedFile("./${i.name}", import.meta.url)\``)
          .join("\n"),
    );
  }

  if (lockCtx) {
    const { lock: merged, orphans, dropped, cededCanonicals } = mergeObserved(
      lockCtx.lock,
      lockCtx.observed,
      // A gate that never writes keeps the `lock import` provenance note: its
      // clearing is not drift. A writing export clears it for what it declares.
      {
        keepAdopted: args.frozenLock === true || args.lockReadOnly === true,
        landedGuids: new Set(allLandings(process.cwd(), lockCtx.lock).flatMap(([, record]) => Object.values(record).map((e) => e.guid))),
      },
    );
    // Never persist a lock the next run's parseLock would reject (duplicate
    // explicit canonicals in code, etc.) — fail the export instead.
    validateLockModel(merged, displayPath(lockPath), lockCtx.observed);
    classifiedLock = merged;
    // An orphan under `--frozen-lock` is a refusal, not a warning: it is the
    // one lock state that means an identity is about to move, and the change
    // gate below cannot see it once a bare export has written it down.
    //
    // Reported FIRST, ahead of the change gate, when both would fire. They fire
    // together on the rename that has not been exported yet, and only this one
    // names the hazard — the change gate would send the reader away to run a
    // local export, which resolves nothing and lands them back here on the next
    // run. Resolving the orphan settles the change too.
    // Named by the flag the caller typed: `--check` implies `--frozen-lock`.
    const gate = checkOnly ? "export --check" : "--frozen-lock";
    // Toolset keys print as `agent:` or `mcpServer:` — the bundle says which.
    // An orphan is not in the bundle; the lock's recorded `type` answers for it.
    const kinds = toolsetKindsFromPayload((bundle as { payload?: unknown }).payload, lockCtx.lock.objects);
    if (args.frozenLock && !args.allowLockOrphans && orphans.length > 0) {
      throw frozenOrphanError(orphans, file, lockPath, gate, { previous: lockCtx.lock, observed: lockCtx.observed, kinds });
    }
    // A missing lock is unchanged when there is nothing to record: an empty
    // workspace (a fresh scaffold) has no identity a CI run could lose, and
    // refusing it failed every new project's first push.
    const changed =
      originalSerialized === undefined
        ? Object.keys(merged.objects).length > 0
        : serializeLock(merged) !== originalSerialized || droppedLandings.length > 0;
    // The gate compares identities: a `guid_source` note an export of this
    // build adds to an older lock changes none.
    const identitiesChanged =
      changed &&
      (originalSerialized === undefined ||
        droppedLandings.length > 0 ||
        serializeLock(withoutGuidSources(merged)) !== serializeLock(withoutGuidSources(lockCtx.lock)));
    if (args.frozenLock && identitiesChanged) {
      throw new CliError(
        DRIFT,
        frozenChangeMessage(gate, lockExists ? lockCtx.lock : undefined, merged, file, lockPath, def, args, kinds, droppedLandings),
      );
    }
    // `--strict` fails on a lock entry that matches nothing exactly as it fails
    // on any other warning — and BEFORE the lock is written, so a refused run
    // leaves it as it found it. Said here, not in `writeLock` below, for that.
    if (args.strict && args.lockReadOnly !== true) {
      warnOrphans(orphans, dropped, cededCanonicals, lockCtx.lock, lockCtx.observed, file, lockPath, kinds, args.frozenLock || args.dryRun === true, args.allowLockOrphans);
      failStrictFindings(args);
    }
    // Lock lands BEFORE the bundle: never ship identities the lock hasn't
    // durably recorded (a crash in between must not orphan minted canonicals).
    //
    // A failure here FAILS the build. Degrading to an unlocked bundle would
    // ship exactly the identities this ordering exists to record first, so the
    // whole cost is paid in the message: name the path, and name the remedy
    // that actually applies. `--no-lock` is only a remedy when there is no lock
    // to disagree with — over an existing one it is refused above, and the way
    // out is a writable path.
    // Nothing to write when frozen and unchanged — least of all under
    // `--check`, which writes nothing, or a lock that does not exist yet.
    // Nor a new lock with nothing in it: an empty workspace has no identity to
    // record, which is exactly why `--frozen-lock` and `--check` pass it with no
    // lock — a plain export writing `{"objects":{}}` and saying "commit it"
    // would be the one command of the three that disagrees.
    // `--frozen-lock` never writes: reaching here under it means the lock is
    // semantically unchanged, and re-serializing an unsorted but equal lock
    // would still touch the file (mtime, key order).
    const skipWrite =
      args.lockReadOnly === true ||
      args.frozenLock ||
      (!lockExists && Object.keys(merged.objects).length === 0);
    // A closure over what it needs, so it can run later: a deferring caller
    // (`deferLockWrite`) still has refusals to make before its first write, and
    // a refused run must leave the lock — and the "commit it" line — as it
    // found them.
    const observedLock = lockCtx.lock;
    const observed = lockCtx.observed;
    const repinned = lockCtx.repinned ?? [];
    // A dry run writes nothing, but an entry that matches nothing is as true of
    // its preview as of the real run — and the real run said it. The warning
    // is the lock's reading, not its write (E2E pass 16).
    const dryRun = args.dryRun === true;
    let orphansWarned = false;
    const warnLockOrphans = (pruned?: ReadonlySet<string>): void => {
      if (orphansWarned || args.strict || (args.lockReadOnly === true && !dryRun)) return;
      orphansWarned = true;
      const unexplained = pruned === undefined ? orphans : orphans.filter((key) => !pruned.has(key));
      // An entry the landing pruned left the lock with the object it pinned: nothing is ceded any more.
      const ceded = pruned === undefined ? cededCanonicals : cededCanonicals.filter((key) => !pruned.has(key));
      warnOrphans(unexplained, dropped, ceded, observedLock, observed, file, lockPath, kinds, dryRun || skipWrite, args.allowLockOrphans);
    };
    const writeLock = (commitOpts?: CommitLockOptions): void => {
      try {
        if (!skipWrite) writeLockFile(lockPath, merged);
      } catch (err) {
        const noDir = missingLockDir(args);
        if (noDir !== undefined) throw new UsageError(noDir);
        const reason = err instanceof Error ? err.message : String(err);
        const remedy = lockExists
          ? "Point at a writable location with `--lock=<path>`, or make the directory writable."
          : "Build without a lock with `--no-lock` (identities then derive from names), or make the directory writable.";
        const message = `Could not write ${displayPath(lockPath)}: ${reason}\n${remedy}`;
        throw isUnwritableError(err) ? new UsageError(message) : new Error(message);
      }
      // Report the CREATION, and report the PATH. The lock is written beside the
      // entry file, not at the project root, and the bare filename reads as a
      // root-level artifact by analogy with package-lock.json — so a silent write
      // sends people looking for `./xano.lock` and find nothing. This is also the
      // more important of the two writes: it is the one the user is told to
      // commit, and now it lands on a run they did not ask for a lock on.
      if (!lockExists && !skipWrite) {
        noteLockCreated(lockPath, commitOpts?.to === undefined ? args : { ...args, to: commitOpts.to }, {
          adopt: commitOpts?.nothingToAdopt !== true,
        });
      }
      // An existing lock that this run changed is said too, in one line: it is a
      // file the reader commits, and a silent rewrite shows up as a diff nobody
      // announced.
      else if (lockExists && !skipWrite && changed) info(`Updated ${displayPath(lockPath)} — commit it.`);
      // A def's explicit `guid:` won over the entry the lock held for it.
      if (!skipWrite) {
        for (const r of repinned) {
          const shown = displayLockKey(r.key, kinds);
          if (!r.key.startsWith("dbo:")) {
            detail(`${shown} now pins ${r.to}, the guid its def declares (the lock had ${r.from}).`);
            continue;
          }
          // A table re-pinned in code is a delete+create wherever it landed
          // under the old guid; the lock keeps that guid as `replaced`, so a
          // keep-data deploy there refuses instead of dropping its rows.
          const name = r.key.slice("dbo:".length);
          if (merged.objects[r.key]?.replaced?.includes(r.from) !== true) {
            detail(`${shown} now pins ${r.to}, the guid its def declares (the lock had ${r.from}).`);
            continue;
          }
          warn(
            `${shown} now pins ${r.to}, the guid its def declares — the lock had ${r.from}. An environment holding ` +
              `the table under ${r.from} would drop it with its rows at the next merge, so xano.lock keeps ` +
              `${r.from} as \`replaced\` and a keep-data deploy there refuses until you choose. If it is the same ` +
              `table, set its def to \`guid: "${r.from}"\`.`,
            "lock.repinned-table",
            [
              `if the old table is not wanted: xanosdk lock prune --identity-only ${shellWord(`table:${name}`)} ` +
                `--lock=${shellWord(displayPath(lockPath))} --yes — then, where an environment holds it, rename the def ` +
                `to "${name}_tmp" and deploy, then back to "${name}" and deploy again: a merge cannot replace a table ` +
                `with another of its own name, so the first drops the old table with its rows and the second renames the new one`,
            ],
          );
        }
      }
      if (opts.deferOrphanWarning !== true) warnLockOrphans(commitOpts?.pruned);
    };
    if (opts.deferOrphanWarning === true) deferredOrphans = warnLockOrphans;
    // No lock, and nothing to record in one: there is no file to name, as
    // `--check` reports the same tree (`lock: null`).
    lockReport =
      !lockExists && Object.keys(merged.objects).length === 0
        ? null
        : { path: displayPath(lockPath), changed: !skipWrite && changed };
    if (opts.deferLockWrite === true && !skipWrite) {
      commitLock = writeLock;
      if (opts.deferOrphanWarning !== true) uncommittedOrphans = () => warnLockOrphans();
      // A deferred write never runs on a dry run: its warnings are said now.
      if (dryRun && opts.deferOrphanWarning !== true) warnLockOrphans();
    } else writeLock();
  }

  reportCapabilities(bundle);

  // Seed content rides in the same lock context as the export it accompanies,
  // so `resolveRef("dbo", def)` inside buildSeedContentFiles yields the same
  // guid the table emitted in the bundle. Built only when the deploy path asks
  // for it; otherwise report which seeded tables were left out so `export` can
  // warn. Resolved even when the artifact will not carry it. Otherwise a defect
  // only `deploy` could see — a JSON `import()` missing its `with { type:
  // "json" }` attribute, an unknown column, a value that will not coerce —
  // would pass export and fail at deploy, AFTER an environment had been
  // provisioned. A check that runs only on the destructive path is in the wrong
  // place. Same function either way, so the two commands cannot drift apart in
  // what they accept.
  // A seed refusal comes after the export printed its warnings; the failure
  // document carries them in `details.warnings`, beside the refused rows in
  // `details.diagnostics` (`carryRunWarnings`), as for every export failure.
  // Each distinct hosted file's bytes, as archive members beside the bundle.
  const files: ArchiveEntry[] = hostedFiles.files().map((f) => ({ name: hostedFileArchivePath(f), content: f.bytes }));
  // The same resolver as the export when the rows ship, so a file a row and an
  // icon share is one archive member; a throwaway one when they do not, so a
  // bad reference still fails here rather than at deploy.
  const resolvedContent = await buildSeedContentFiles(
    def.tables(),
    opts.seed ? hostedFiles : hostedFileResolver(),
    def.workspaceSettings().use_xdo === true,
  );
  const content = opts.seed ? resolvedContent : [];
  const nonPublicSeedValues = opts.seed ? await collectNonPublicSeedValues(def.tables()) : [];
  const omittedSeedTables = opts.seed ? [] : def.tables().filter((t) => t.seed !== undefined && !(Array.isArray(t.seed) && t.seed.length === 0)).map((t) => t.name);

  // Only after the compile has succeeded: a failing `export --strict` (or any
  // refused build) rewrote AGENTS.md on its way to the refusal.
  await refreshAgentGuidance(args);

  return {
    bundle: serializeBundle(bundle),
    bundleObject: bundle,
    content,
    files,
    omittedSeedTables,
    nonPublicSeedValues,
    lock: lockReport,
    declaredEnvNames: declaredEnv(def.workspaceSettings()).map((e) => e.name),
    warnings: [
      ...buildWarnings.map(jsonWarning),
      ...exportFindings,
    ],
    ...(classifiedLock !== undefined ? { classifiedLock } : {}),
    ...(commitLock !== undefined ? { commitLock } : {}),
    ...(deferredOrphans !== undefined ? { warnLockOrphans: deferredOrphans } : {}),
    ...(uncommittedOrphans !== undefined ? { warnOrphansUncommitted: uncommittedOrphans } : {}),
  };
}

/**
 * How a DEFAULT sidecar path is named in a report: relative to the working
 * directory when it is under it — the spelling `secrets fill` and every other
 * path in the run use, so `xanosdk export app/xano/index.ts` names
 * `app/xano/.env` — and otherwise relative to the project.
 *
 * The project root is the anchor for a run from OUTSIDE the tree: a
 * `relative(cwd, …)` there becomes a wall of `../..`, the ordinary case under a
 * test runner and a monorepo task runner alike. Anchored at the project this is
 * `xano/.env` for a scaffolded project and `backend/.env` for one whose backend
 * is a sibling.
 *
 * `fallback` covers the path that escapes both, where there is no relative
 * spelling to give.
 */
function projectRelative(path: string, entryFile: string, fallback: string): string {
  // A run that moved to its project's root spells the path from where it was typed.
  if (pathsShownFrom() !== undefined) return displayPath(path);
  return (
    relForwardSlash(process.cwd(), path) ||
    relForwardSlash(projectRootFrom(dirname(resolve(entryFile))), path) ||
    fallback
  );
}

/**
 * The secrets file `xanosdk secrets fill` mints into for this entry, and the
 * command as it must be typed. The entry is named: the bare command looks for
 * the scaffold's `xano/index.ts`, so outside a scaffold it finds nothing — and
 * the file is the one this entry reads, not the scaffold's `xano/.secrets.json`.
 */
function secretsRemedyFor(entryFile: string): SecretsRemedy {
  const path = defaultWorkspaceSecretsPath(entryFile);
  const fill = `xanosdk secrets fill ${shellWord(entryFile)}`;
  // `secrets fill` refuses to create the backend directory (a root-level entry
  // outside a scaffold reads `xano/`, which may not exist yet), so the remedy
  // creates it first rather than printing a command that fails as typed.
  const dir = dirname(path);
  return {
    file: projectRelative(path, entryFile, WORKSPACE_SECRETS_FILE),
    fill: existsSync(dir) ? fill : `mkdir ${shellWord(displayPath(dir))} && ${fill}`,
  };
}

/**
 * Resolve the backend env values a compile will send, report what it found, and
 * refuse the one case that destroys something.
 *
 * Every command that compiles an entry file runs through here, so the values a
 * bundle carries never depend on which verb produced it. What differs is the
 * consequence: `deploy` IMPORTS these bytes into an environment someone keeps,
 * and a deploy REPLACES the target's env set — so a declared name nobody
 * supplied would overwrite a live value with an empty string. `export` writes a
 * file, `preflight` imports into a throwaway tenant it creates itself, and
 * `release create` cuts from what is already running, so all three report.
 *
 * The scoping matters beyond correctness: a refusal on a harmless command
 * trains everyone to pass the opt-out by reflex, and that habit follows them to
 * the deploy that does destroy data.
 */
function resolveWorkspaceEnv(
  args: ParsedArgs,
  file: string,
  settings: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const declared = declaredEnv(settings);
  const declaredNames = declared.map((e) => e.name);
  const declaredValues = Object.fromEntries(declared.map((e) => [e.name, e.value]));
  const explicit = args.envFile !== undefined ? resolve(args.envFile) : undefined;
  // An explicit path that cannot be read is a hard error — it was asked for.
  // The default simply may not exist, which is the ordinary state of a fresh
  // clone and is reported rather than thrown.
  // Named once, then used for BOTH the "read it" and the "did not find it"
  // report. The path is resolved from the entry, so in a project whose backend
  // is not `xano/` the constant would name a file this run never looked at —
  // which is the same wrong-directory report the resolver was fixed to stop
  // producing. Anchored at the project, so it is identical to
  // `WORKSPACE_ENV_FILE` for every scaffolded project, where the backend IS
  // `xano/`.
  const defaultPath = defaultWorkspaceEnvPath(file);
  const defaultLabel = projectRelative(defaultPath, file, WORKSPACE_ENV_FILE);
  const fileValues =
    explicit !== undefined ? parseEnvFile(explicit) : readWorkspaceEnvFile(defaultPath);
  // A name no env var can have is refused before it is sent: the import took
  // `bad key` / `1BAD` and landed it, and `env pull` then could not write it
  // back. `--env-var` is refused as it is parsed; these are the other two ways
  // a name reaches the bundle.
  const badDeclared = declaredNames.filter((n) => !isRepresentableName(n));
  if (badDeclared.length > 0) {
    const one = badDeclared.length === 1;
    throw new UsageError(
      `\`workspaceConfig({ env })\` declares ${quotedNames(badDeclared)}, which ${one ? "is not a usable env var name" : "are not usable env var names"}. ` +
        `${envNameRule()} Rename ${one ? "it" : "them"} there, and in every \`env("…")\` that reads ${one ? "it" : "them"}.`,
    );
  }
  const badInFile = Object.keys(fileValues ?? {}).filter((n) => !isRepresentableName(n));
  if (badInFile.length > 0) {
    const one = badInFile.length === 1;
    const where = explicit !== undefined ? displayPath(explicit) : defaultLabel;
    throw new UsageError(
      `\`${where}\` sets ${quotedNames(badInFile)}, which ${one ? "is not a usable env var name" : "are not usable env var names"}. ` +
        `${envNameRule()} Rename ${one ? "it" : "them"} in the file.`,
    );
  }
  // No filtering. `xano/.env` is backend-dedicated again now that documentation
  // tokens live in their own file, so every name in it is sent — exactly as an
  // explicit `--backend-env-file` behaves.
  const resolution = classifyEnv({
    fileValues: fileValues ?? {},
    flagValues: args.envVars,
    declaredNames,
    declaredValues,
  });

  const source =
    explicit !== undefined
      ? displayPath(explicit)
      : fileValues !== undefined
        ? defaultLabel
        : undefined;
  const allowed = new Set(args.allowEmptyEnv);
  // A name the source does not declare is refused, as `--allow-empty-doc-token`
  // refuses a scope nothing gates: accepted, it excuses nothing, and the author
  // believes the name they meant to type is handled. A usage error — the flag's
  // value was mistyped — but with no usage block: the declared names are the fix.
  // An empty `--env-var NAME=` needs the flag whether or not NAME is declared.
  const undeclared = [...allowed].filter((n) => !declaredNames.includes(n) && args.envVars[n] !== "");
  if (undeclared.length > 0) {
    throw new UsageError(
      `--allow-empty-env: ${safeNames(undeclared)} ${undeclared.length === 1 ? "is" : "are"} not ` +
        `declared.` +
        (declaredNames.length === 0
          ? ` This workspace declares no env vars — a name is declared in \`workspaceConfig({ env })\`.`
          : ` Declared: ${safeNames(declaredNames)}.`),
    );
  }
  // `clearing` is the whole policy input: a declared name the source spells a
  // real value for is sent with that value and destroys nothing, so refusing it
  // would break every hand-authored `workspaceConfig({ env })` in existence.
  const unsupplied = resolution.clearing.filter((n) => !allowed.has(n));
  const refuses = REFUSES_EMPTY_ENV.has(args.command ?? "");
  const flagged = Object.keys(args.envVars).length;
  // `workspace diff` compiles the same bundle to COMPARE, and imports nothing:
  // "will be ADDED" there described a deploy nobody ran.
  const comparesOnly = args.command === "workspace" && args.subcommand === "diff";
  // `release create` imports nothing either, and a release carries no env:
  // "this bundle will clear it if it is imported" described an import that
  // never happens (E2E pass 36).
  const cutsRelease = args.command === "release" && args.subcommand === "create";
  // A `--keep-data` deploy MERGES, and a merge's env is add-only: a name the
  // target holds keeps its live value whatever the bundle says, and a name it
  // does not hold is added — empty, which clears nothing. So an empty value
  // destroys nothing there, and refusing it is refusing a harmless deploy. The
  // one exception is decided later, when the arm is: an environment whose data
  // cannot be vouched for is REPLACED despite the flag (see
  // `envRefusalIfReplaced`).
  const merges = refuses && args.command === "deploy" && args.keepData && !args.reset && args.to === undefined;
  // A `deploy --to` without `--replace` lands as a merge too, and its env is
  // add-only the same way — but it still refuses: the name it would create
  // there carries no value on a backend someone keeps. Worded as the merge it
  // is (E2E pass 29: it said a replace would clear the value).
  const toMerge = refuses && args.command === "deploy" && args.to !== undefined && !args.replace;
  reportWorkspaceEnv({
    declaredNames,
    resolution,
    source,
    flagged,
    allowed,
    refuses,
    defaultLabel,
    comparesOnly,
    cutsRelease,
    merges: merges ? "`--keep-data`" : toMerge ? "`--to`" : undefined,
  });
  // The example is offered to copy only for what it lists (E2E pass 29: it was
  // offered while it lacked the very name refused).
  const examplePath = `${defaultPath}.example`;
  const exampleLacks = existsSync(examplePath)
    ? unsupplied.filter((n) => !namesInEnvExample(examplePath).includes(n))
    : undefined;
  const dryRun = args.dryRun === true;
  const refusal = (replaceWhy?: string): string =>
    unsuppliedEnvError(unsupplied, source ?? defaultLabel, source !== undefined, exampleLacks, {
      ...(replaceWhy !== undefined ? { replaceWhy } : {}),
      mode: replaceWhy === undefined && toMerge ? "merge" : "replace",
      dryRun,
    });
  mergeExcusedEnv = merges && unsupplied.length > 0 ? refusal : undefined;
  if (refuses && !merges && unsupplied.length > 0) {
    // A dry run reports what the real one would do — the refusal included —
    // and sends nothing, so it has nothing to refuse (E2E pass 29).
    if (dryRun) warn(refusal(), "workspace-env.unsupplied");
    else throw new Error(refusal());
  }
  return resolution.values;
}

/**
 * Resolve the documentation tokens a compile will send, report what it found,
 * and refuse the one case that destroys something.
 *
 * The backend-env twin above, deliberately shaped the same way: the same
 * three-state classification, the same per-scope opt-out with no bare form, and
 * the same command doing the refusing. A second idiom here would mean a user who
 * has learned one of them has not learned the other. What differs is the file
 * and the key — a backend value is addressed by name in `xano/.env`, a doc token
 * by the object that holds it in `xano/.secrets.json`.
 *
 * What also differs is WHAT is destroyed. A deploy carrying a declared gate that
 * nothing supplied would, without this, turn a Private doc site public — every
 * endpoint, input and response shape in it readable by anyone with the URL. So
 * `deploy` refuses; `export` writes a file, `preflight` imports into a throwaway
 * tenant it creates itself, and `release create` cuts from what is already
 * running, so all three report and complete.
 *
 * An unsupplied gate is not merely warned about on the non-refusing commands:
 * the block is dropped entirely (see `resolveDocumentationTokens` in
 * `workspace/documentation-token.ts`), so the bytes they produce cannot clear a
 * gate either. The one exception is a PUBLISHED API group, where an absent key
 * IS the clearing — `checkApiGroupDocsExposure` fails the export for that, since
 * there is no safe bundle to write.
 *
 * These values NEVER reach the bundle's top-level `env`. That array is the
 * workspace's own environment, readable from every stack with `env("NAME")`, and
 * a doc-site token is not one of its variables — `export()` substitutes them
 * into the documentation blocks instead.
 */
function resolveDocumentationTokens(
  args: ParsedArgs,
  file: string,
  def: Xano,
): { values: Record<string, string>; allowEmpty: ReadonlySet<string> } {
  const declared = def.documentationTokenNames();
  // Resolved even when nothing is declared, so `--doc-token` naming a scope the
  // source does not gate is still reported rather than silently dropped.
  const byLabel = new Map<string, DocumentationTokenDeclaration[]>();
  for (const d of declared) {
    const label = documentationScopeFlagLabel(d.scope);
    byLabel.set(label, [...(byLabel.get(label) ?? []), d]);
  }

  /**
   * One user-typed label → the scope key it addresses.
   *
   * A label is a remote string with nothing constraining its shape, so both
   * failures are real and both are refusals rather than guesses: a label no
   * scope answers to is a typo, and a label two groups answer to would clear or
   * supply the wrong one. Naming the candidates is the whole value of refusing.
   */
  const keyFor = (label: string, flag: string): string => {
    // `workspace` is RESERVED, resolved before any group is consulted. An API
    // group may legitimately be called that, and without this the two share one
    // label: the workspace's own gate becomes unaddressable, and the error blames
    // "2 API groups" when one of them is not a group at all.
    const reserved = declared.find((d) => d.scope.kind === "workspace");
    if (label === "workspace" && reserved !== undefined) return reserved.key;
    const matches = (byLabel.get(label) ?? []).filter((d) => d.scope.kind === "api_group");
    if (matches.length === 1) return matches[0]!.key;
    const known = [...byLabel.keys()];
    if (matches.length === 0) {
      // The `--allow-empty-env` twin: a mistyped flag value, named by what is declared.
      throw new UsageError(
        `${flag}: no documentation gate is declared for ${JSON.stringify(label)}.` +
          (known.length === 0
            ? ` This workspace declares none — a gate is \`documentation: { require_token: true }\`.`
            : ` Declared: ${safeNames(known)}.`),
      );
    }
    throw new Error(
      `${flag}: ${matches.length} API groups are named ${JSON.stringify(label)}, so that name ` +
        `does not say which one you mean. Rename one of them, or pull again so the group you ` +
        `want carries its own entry in \`${projectRelative(defaultWorkspaceSecretsPath(file), file, WORKSPACE_SECRETS_FILE)}\`.` +
        (label === "workspace"
          ? ` (\`workspace\` addresses the WORKSPACE's own gate, which this source does not ` +
            `declare — a group of that name cannot take the label.)`
          : ""),
    );
  };

  // Null-prototype: a scope keyed `__proto__` is stored, not a prototype set.
  const values = Object.create(null) as Record<string, string>;
  const secretsPath = args.secretsFile !== undefined ? resolve(args.secretsFile) : defaultWorkspaceSecretsPath(file);
  // An explicit `--secrets-file` that cannot be read is a hard error — it was
  // asked for. The default simply may not exist, which is the ordinary state of
  // a fresh clone and is reported rather than thrown.
  // `--secrets-file` was asked for, so an absent one is a hard error; the default
  // simply may not be there. One reader decides both, the way `parseEnvFile`
  // already does for `--backend-env-file`.
  const stored = readSecretsFile(secretsPath, args.secretsFile !== undefined ? "--secrets-file" : undefined);
  // The same treatment either way, for the reason the env twin gets it: the
  // default is resolved from the entry, so naming the constant would report a
  // file this run never opened in a project whose backend is not `xano/`.
  const source =
    args.secretsFile !== undefined
      ? displayPath(secretsPath)
      : projectRelative(secretsPath, file, WORKSPACE_SECRETS_FILE);
  for (const [key, entry] of Object.entries(stored?.documentationTokens ?? {})) {
    values[key] = entry.value;
  }
  // `--doc-token` wins over the file, exactly as `--env-var` does, so CI can
  // supply one scope without mounting a file for it.
  for (const [label, value] of Object.entries(args.docTokens)) {
    values[keyFor(label, "--doc-token")] = value;
  }
  const allowEmpty = new Set(args.allowEmptyDocToken.map((l) => keyFor(l, "--allow-empty-doc-token")));

  const declaredKeys = new Set(declared.map((d) => d.key));
  const supplied = declared.filter((d) => Object.hasOwn(values, d.key));
  const cleared = declared.filter((d) => !Object.hasOwn(values, d.key) && allowEmpty.has(d.key));
  // GATED scopes only. An ungated block (`require_token: false`) with no stored
  // value is a scope that has no token, which is an ordinary thing to be: the
  // block ships as authored, and there is no gate to lose.
  // Refusing over it demanded a token `secrets fill` will not mint, leaving only
  // an opt-out that claims to clear a gate that does not exist.
  const unsupplied = declared.filter(
    (d) => d.gated && !Object.hasOwn(values, d.key) && !allowEmpty.has(d.key),
  );

  // Said only when there is something to resolve: a gated scope, or a value
  // that is being applied. An ungated block with no token (`require_token:
  // false`) has nothing to resolve, and "0 of 1 scope resolved" read as a miss.
  if (supplied.length > 0 || declared.some((d) => d.gated)) {
    // "scope(s)", not "gate(s)": a block may store a token with the gate off,
    // and that value is substituted exactly like a gated one. Counting gates
    // here reported "0 of 0" for a workspace whose three tokens were in fact
    // being applied.
    const flagKeys = new Set(Object.keys(args.docTokens).map((label) => keyFor(label, "--doc-token")));
    const fromFlag = supplied.filter((d) => flagKeys.has(d.key)).length;
    // The denominator is what there IS to resolve: every gated scope, and an
    // ungated one only when a value is being applied to it. An ungated block
    // with no token is not a miss — "1 of 3 scopes resolved" for one gate and
    // two `require_token: false` groups read as two tokens missing.
    const toResolve = declared.filter((d) => d.gated || Object.hasOwn(values, d.key));
    info(
      `Documentation tokens: ${supplied.length} of ${countOf(toResolve.length, "scope")} resolved` +
        suppliedFrom(supplied.length - fromFlag, source, fromFlag, "--doc-token", " from"),
    );
  }
  // An entry nothing in the source claims. Reported, never pruned: the build
  // cannot tell a rename from a group that is temporarily commented out, and
  // silently deleting a secret it cannot re-fetch is unrecoverable.
  const orphans = Object.entries(stored?.documentationTokens ?? {})
    .filter(([key]) => !declaredKeys.has(key))
    .map(([, entry]) => entry.label);
  if (orphans.length > 0) {
    exportWarn(
      "doc-token.orphan",
      `Documentation tokens: \`${source}\` holds ${orphans.length} entr${orphans.length === 1 ? "y" : "ies"} ` +
        `no scope in this source claims — ${safeNames(orphans)}. Nothing is sent for ` +
        `${orphans.length === 1 ? "it" : "them"}, and nothing is deleted. ` +
        // A lock keeps a renamed group's identity, so there the cause is a
        // group removed, or its gate dropped from the source.
        (existsSync(join(dirname(secretsPath), "xano.lock"))
          ? `Usually an API group that was removed, or whose \`documentation\` gate was dropped; `
          : `Usually a renamed API group in a project with no lock; `) +
        // Only a decoded project has a pull that rebuilds the file.
        (existsSync(join(dirname(secretsPath), ".xanosdk-codegen.json"))
          ? `pull again to rebuild the file.`
          : `move the token to the group's new entry, or delete ${orphans.length === 1 ? "the entry" : "them"} from \`${source}\`.`),
    );
  }
  const refuses = REFUSES_EMPTY_DOC_TOKEN.has(args.command ?? "");
  // A merge does not write the workspace's `documentation` block (a group's it
  // does), so the workspace gate a merge carries is never applied: the live one
  // stays as it is. `--keep-data` merges only when the environment has rows it
  // can vouch for, so its workspace refusal is deferred to the arm (see
  // `docTokenRefusalIfReplaced`); a `--to` merge never replaces.
  const workspaceKept = refuses ? docMergeOf(args) : undefined;
  const clearedWs = workspaceKept === undefined ? [] : cleared.filter((d) => d.scope.kind === "workspace");
  const clearedApplied = cleared.filter((d) => !clearedWs.includes(d));
  if (clearedApplied.length > 0) {
    exportWarn(
      "doc-token.cleared",
      `Documentation tokens: ${safeNames(clearedApplied.map((d) => documentationScopeFlagLabel(d.scope)))} ` +
        `will be sent EMPTY (--allow-empty-doc-token). Whatever gate the target holds for ` +
        `${clearedApplied.length === 1 ? "that doc site" : "those doc sites"} is cleared, and its docs ` +
        `become publicly readable.`,
    );
  }
  if (clearedWs.length > 0) {
    exportWarn(
      "doc-token.cleared",
      `Documentation tokens: workspace — --allow-empty-doc-token is not applied: a merge leaves the ` +
        `workspace's documentation gate as it is.` +
        (workspaceKept === "keep-data"
          ? ` If \`--keep-data\` cannot keep this environment and the deploy replaces it instead, the ` +
            `gate is cleared and its docs become publicly readable.`
          : ""),
    );
  }
  const unsuppliedWs = workspaceKept === undefined ? [] : unsupplied.filter((d) => d.scope.kind === "workspace");
  mergeExcusedDocToken =
    workspaceKept === "keep-data" && unsuppliedWs.length > 0
      ? (why) => `${why}, so the deploy replaces it — which writes the workspace's documentation block.
${unsuppliedDocTokenError(unsuppliedWs, secretsRemedyFor(file))}`
      : undefined;
  if (unsuppliedWs.length > 0) {
    exportWarn(
      "doc-token.unsupplied",
      `Documentation tokens: the workspace declares a gate and no token was supplied — a merge does ` +
        `not write the workspace's \`documentation\` block, so the live gate stays as it is.`,
    );
  }
  const applied = unsupplied.filter((d) => !unsuppliedWs.includes(d));
  if (applied.length > 0) {
    if (refuses) throw new Error(unsuppliedDocTokenError(applied, secretsRemedyFor(file)));
    // Split by SCOPE, because dropping the key means opposite things in the two
    // of them. On the workspace an absent key is left alone by the import, so
    // what is lost is only the RESTORE. On a group an absent key is written as
    // the engine default, so the same bytes CLEAR that gate — a single message
    // covering both told the author their bundle was safe when it was not.
    // A group that PUBLISHES its docs is left out: `checkApiGroupDocsExposure`
    // fails the export for it with its own error, and a warning that says
    // "`swagger` is off, nothing is exposed" beside that error is false. This is
    // for the group whose docs are not published, where nothing is exposed.
    const ws = applied.filter((d) => d.scope.kind === "workspace");
    const groups = applied.filter((d) => d.scope.kind === "api_group" && !d.published);
    if (ws.length > 0) {
      exportWarn(
        "doc-token.unsupplied",
        `Documentation tokens: the workspace declares a gate and no token was supplied; no ` +
          `\`documentation\` key is emitted, so this bundle leaves the workspace's gate as it is ` +
          `rather than clearing it — and cannot restore it either.`,
      );
    }
    if (groups.length > 0) {
      exportWarn(
        "doc-token.unsupplied",
        `Documentation tokens: ${countOf(groups.length, "API group")} ${groups.length === 1 ? "declares" : "declare"} a gate with no token ` +
          `(${safeNames(groups.map((d) => documentationScopeFlagLabel(d.scope)))}). Unlike the ` +
          `workspace's, a group's \`documentation\` key is written as the engine default when it ` +
          `is absent, so these bytes CLEAR that group's gate on import. ` +
          `${groups.length === 1 ? "That group does" : "Those groups do"} not publish docs ` +
          `(\`swagger\` is off), so nothing is exposed — turn it on and the export fails until ` +
          `the value is supplied.`,
      );
    }
  }
  return { values, allowEmpty };
}

/**
 * The documentation-token scopes a plain export of `file` would find a value
 * for: the secrets file's entries plus any `--doc-token`. Read quietly — this
 * only decides what a remedy says, so an unreadable file counts as empty
 * rather than failing the message that was about to explain something else.
 */
function availableDocTokenKeys(args: ParsedArgs, file: string): Set<string> {
  const keys = new Set<string>();
  try {
    const secretsPath = args.secretsFile !== undefined ? resolve(args.secretsFile) : defaultWorkspaceSecretsPath(file);
    const stored = readSecretsFile(secretsPath, undefined);
    for (const key of Object.keys(stored?.documentationTokens ?? {})) keys.add(key);
  } catch {
    // Unreadable: nothing is known to be available.
  }
  return keys;
}

/**
 * A stand-in token for every declared documentation scope, for a compile whose
 * bytes are never signed for anyone: `routes`, and `export --check`.
 *
 * A stand-in, not an opt-out to empty: an emptied gate reads to the export's
 * guards as docs about to go PUBLIC — a warning `--strict` promotes into a
 * failure over a bundle nobody ships. With a value in place a gate reads as the
 * gate it is, and every other finding still stands. No secrets file is read,
 * because a fresh clone and a CI checkout have none. The value never leaves the
 * process that made it.
 */
export function checkStandInTokens(def: Xano): { values: Record<string, string>; allowEmpty: ReadonlySet<string> } {
  const values = Object.create(null) as Record<string, string>;
  for (const declared of def.documentationTokenNames()) values[declared.key] = "xanosdk-check";
  return { values, allowEmpty: new Set() };
}

/**
 * Whether this deploy MERGES, which leaves the workspace's documentation block
 * as it is: `--keep-data` (unless `--reset`) or `--to` without `--replace`.
 */
function docMergeOf(args: ParsedArgs): "keep-data" | "to" | undefined {
  if (args.command !== "deploy" || args.localEngine) return undefined;
  if (args.to !== undefined) return args.replace || args.to.startsWith("local") ? undefined : "to";
  return args.keepData && !args.reset ? "keep-data" : undefined;
}

/**
 * The refusal an unsupplied documentation token produces.
 *
 * Follows the backend-env refusal's shape — what is unsupplied, what a deploy
 * does to the target, the ways out, and the repair not to reach for — because
 * they are the same decision about different secrets, and a user who has read
 * one should recognise the other on sight.
 */
function unsuppliedDocTokenError(
  unsupplied: readonly DocumentationTokenDeclaration[],
  remedy: SecretsRemedy,
): string {
  const one = unsupplied.length === 1;
  const labels = unsupplied.map((d) => documentationScopeFlagLabel(d.scope));
  const scopes = unsupplied.map((d) => documentationScopeLabel(d.scope));
  return (
    `Refusing to deploy: ${unsupplied.length} declared documentation gate${one ? "" : "s"} ` +
    `${one ? "has" : "have"} no token — ${safeNames(scopes)}.\n` +
    `Deploying without ${one ? "it" : "them"} would leave ${one ? "that" : "those"} doc ` +
    `site${one ? "" : "s"} without the gate this source describes — and \`--allow-empty-doc-token\` ` +
    `would actively clear whatever gate the target holds, making every endpoint, input and ` +
    `response shape in ${one ? "it" : "them"} publicly readable.\n` +
    `Run \`${remedy.fill}\` to mint ${one ? "a token" : "tokens"} into \`${remedy.file}\`, ` +
    // No `xanosdk pull` here: every gate listed is declared in THIS source, and
    // a pull replaces the source with the target's — an authored
    // `require_token: true` read back as whatever the target holds (E2E pass
    // 17 #6). Minting, passing or mounting the token keeps the source as written.
    `pass ` +
    `${one ? "it" : "them"} with ${labels.map((l) => `\`--doc-token "${l}=<value>"\``).join(" ")}, ` +
    `point at a mounted file with \`--secrets-file <path>\`, or — if opening ` +
    `${one ? "that doc site" : "those doc sites"} is what you meant — ` +
    `${labels.map((l) => `\`--allow-empty-doc-token="${l}"\``).join(" ")}.\n` +
    `Do not put the token back into \`documentation: { token }\` — a value there is committed ` +
    `to the repo, which is what \`${remedy.file}\` replaces, and the export refuses it.`
  );
}

/**
 * The credential scope this run resolved, for {@link trackedBackend}: a
 * deploy resolves its credential BEFORE the compile whose refusals read it, so
 * the scope is known by then; the refusal is made several layers below any
 * `auth`. Forgotten when the run ends, as the hint context is.
 */
let runScope: EnvScope | undefined;

/** Record the credential scope this run acts as. `undefined` forgets it. */
export function noteRunScope(scope: EnvScope | undefined): void {
  runScope = scope === undefined ? undefined : { workspaceId: scope.workspaceId, instance: scope.instance, profile: scope.profile };
}

/**
 * What a bare `env pull` run here — with THIS run's credential — would go to,
 * and for an ephemeral, which one. `kind` is the same decision the bare
 * command reaches (`readTrackedBackend`), so an ephemeral recorded under
 * another instance, workspace or profile does not count; `null` means it
 * refuses ("no backend to default to", "No ephemeral is tracked on <host>")
 * and a remedy naming it would dead-end. No credential resolved means an
 * ephemeral cannot be looked up, and only a Xano Engine counts. The
 * record says nothing of liveness, and an ephemeral expires within the hour: a
 * pull offered against one already gone exits 8 (E2E pass 17 #3). Its recorded
 * expiry is read here, for free; a deletion before it is caught on the refusal
 * path by {@link refineGonePullHint}, which looks the ephemeral up.
 */
function trackedBackend(
  cwd: string = process.cwd(),
  scope: EnvScope | undefined = runScope,
): { kind: string | null; ephemeral?: { name: string; expired: boolean } } {
  try {
    const kind = readTrackedBackend({ cwd, scope }).kind;
    if (kind !== "ephemeral" || scope === undefined) return { kind };
    const record = getEnvironment(readEphemeralState(cwd), scope);
    return record === undefined ? { kind } : { kind, ephemeral: { name: record.name, expired: isExpired(record.expires_at) } };
  } catch {
    // An unreadable record is not a backend a pull can reach.
    return { kind: null };
  }
}

/**
 * The `env pull` clause a refusal offered for a tracked ephemeral, kept so the
 * refusal path can take it back when that ephemeral turns out to be gone. Set
 * while the message is composed, read (and forgotten) once it is thrown.
 */
let offeredPull: { name: string; clause: string } | undefined;

/**
 * Set by a `--keep-data` compile that let declared names with no value through
 * because a merge cannot clear them: the refusal it did not throw, composed
 * with the reason the deploy replaces after all.
 */
let mergeExcusedEnv: ((replaceWhy: string) => string) | undefined;

/** The `--keep-data` twin of {@link mergeExcusedEnv} for the workspace's documentation gate. */
let mergeExcusedDocToken: ((replaceWhy: string) => string) | undefined;

/**
 * The workspace documentation-gate refusal a `--keep-data` compile deferred,
 * for a deploy whose arm is a REPLACE after all — new, recreated or
 * unvouched-for: a replace writes the workspace's documentation block, and
 * without the token the gate is gone. Undefined when nothing was deferred.
 */
export function docTokenRefusalIfReplaced(replaceWhy: string): string | undefined {
  return mergeExcusedDocToken?.(replaceWhy);
}

/**
 * The refusal a `--keep-data` compile deferred, for a deploy whose arm turned
 * out to be a REPLACE of an environment that holds data (`--keep-data` had
 * nothing it could vouch for): there, an empty value does clear the live one.
 * Undefined when nothing was deferred.
 */
export function envRefusalIfReplaced(replaceWhy: string): string | undefined {
  return mergeExcusedEnv?.(replaceWhy);
}

/**
 * The parenthesis after "Put the values in `<source>`": the example to copy —
 * with the names it does not list, which copying it does not supply — and a
 * pull only when one can run.
 */
function fillFrom(source: string, exampleLacks: readonly string[] | undefined, one = false): string {
  const tracked = trackedBackend();
  const expired = tracked.ephemeral?.expired === true;
  const pull = `run \`xanosdk env pull${contextFlags()}\` to fetch ${one ? "it" : "them"} from the backend this project deployed`;
  const copy =
    exampleLacks === undefined
      ? undefined
      : exampleLacks.length === 0
        ? `copy \`${source}.example\` to start`
        : `copy \`${source}.example\` to start and add ${exampleLacks.join(", ")}, which it does not list`;
  const ways = [
    ...(copy !== undefined ? [copy] : []),
    ...(tracked.kind !== null && !expired ? [pull] : []),
  ];
  offeredPull = tracked.ephemeral !== undefined && !expired ? { name: tracked.ephemeral.name, clause: pull } : undefined;
  return ways.length === 0 ? "" : ` (${ways.join(", or ")})`;
}

/**
 * Gone already by its recorded expiry: said, so the reader does not go looking
 * for the pull the message used to offer — as a sentence of its own below the
 * ways out, never a clause wedged into their list.
 */
function expiredPullNote(): string {
  const tracked = trackedBackend();
  return tracked.ephemeral?.expired === true ? `\n${pullGone(tracked.ephemeral.name, "has expired")}` : "";
}

/** The sentence that takes a pull back: the tracked ephemeral cannot answer one. */
function pullGone(name: string, how: "has expired" | "is gone"): string {
  return `The ephemeral this project deployed (${name}) ${how}, so there is no backend to pull the values from.`;
}

/** The line every ways-out list is followed by — where a pull-gone sentence goes, above it. */
const DO_NOT_COMMIT = "\nDo not put the value back into `workspaceConfig({ env })`";

/**
 * On the refusal path only: when the refusal offered `env pull` against a
 * tracked ephemeral, look that ephemeral up (one read) and, when it is gone,
 * take the offer back — the pull it named would exit 8. A lookup that fails
 * proves nothing, and the offer stands.
 */
async function refineGonePullHint(err: unknown): Promise<void> {
  const offer = offeredPull;
  offeredPull = undefined;
  const auth = lastResolvedAuth()?.auth;
  if (offer === undefined || auth === undefined || !(err instanceof Error) || !err.message.includes(offer.clause)) return;
  let gone: boolean;
  try {
    const { lookupEphemeral } = await import("./source-resolve.js");
    gone = (await lookupEphemeral(auth, offer.name)) === null;
  } catch {
    return;
  }
  if (!gone) return;
  const taken = err.message.includes(`, or ${offer.clause})`)
    ? err.message.replace(`, or ${offer.clause})`, ")")
    : err.message.replace(` (${offer.clause})`, "");
  err.message = taken.replace(DO_NOT_COMMIT, `\n${pullGone(offer.name, "is gone")}${DO_NOT_COMMIT}`);
}

/**
 * The most-read text in this feature.
 *
 * A fresh clone and a CI checkout both have no `xano/.env` — values are never
 * written locally — so every pulled project deploys into this until someone
 * fills the file in. It therefore has to name all three of: which variables,
 * which file, and the way out.
 */
function unsuppliedEnvError(
  unsupplied: readonly string[],
  source: string,
  found: boolean,
  /**
   * The unsupplied names `<source>.example` does not list, or `undefined` when
   * there is no example — named only when there is one, as a file to copy.
   */
  exampleLacks: readonly string[] | undefined,
  opts: {
    /** Why a `--keep-data` deploy replaces after all — said in place of "A deploy REPLACES". */
    replaceWhy?: string;
    /** `merge`: a `deploy --to` without `--replace`, whose env is add-only. */
    mode: "replace" | "merge";
    /** A `--dry-run`: said as what the real deploy would refuse, not as a refusal. */
    dryRun: boolean;
  },
): string {
  const one = unsupplied.length === 1;
  const { replaceWhy } = opts;
  const merge = opts.mode === "merge" && replaceWhy === undefined;
  return (
    (opts.dryRun ? "Dry run — the deploy would refuse: " : "Refusing to deploy: ") +
    `${unsupplied.length} declared env variable${one ? "" : "s"} ` +
    `${one ? "has" : "have"} no value — ${unsupplied.join(", ")}.\n` +
    (merge
      ? `A \`--to\` deploy merges the env add-only: where the target holds ${one ? "that name" : "those names"}, the ` +
        `live value is kept, and where it does not, ${one ? "it" : "each"} would be created there with no value.\n`
      : (replaceWhy !== undefined ? `${replaceWhy}: this deploy REPLACES` : "A deploy REPLACES") +
        ` the backend's env set, so sending this bundle would clear ` +
        `${one ? "that value" : "those values"} in the target.\n`) +
    // `source` is the RESOLVED default even when no file was found, so the way
    // out names the directory this project actually uses. Naming the `xano/`
    // constant here told a project whose backend is a sibling to put its values
    // in a directory that is not its backend — the fatal message contradicting
    // the info line printed one moment earlier.
    (found
      ? `Add ${one ? "it" : "them"} to \`${source}\`, `
      : `Put the value${one ? "" : "s"} in \`${source}\`` + fillFrom(source, exampleLacks, one) + `, `) +
    `pass ${one ? "it" : "them"} with \`--env-var NAME=value\`, or — if ${merge ? "sending" : "clearing"} ` +
    `${one ? "it" : "them"}${merge ? " empty" : ""} is what you meant — \`--allow-empty-env=${unsupplied.join(",")}\`.` +
    (found ? "" : expiredPullNote()) +
    // The one thing the ways out do not say. For a project scaffolded without
    // `AGENTS.md`, this message is the ONLY text in the loop, and the tempting
    // repair is the exact habit `xano/.env` exists to break.
    `${DO_NOT_COMMIT} — a value there is committed ` +
    `to the repo, which is what ${source} replaces.`
  );
}

/**
 * Report what the backend env resolution did, before the bundle is built.
 *
 * The MERGE itself happens inside `export()` (see `buildBundle`): the bundle is
 * signed, so patching it afterwards invalidates the signature, and the env the
 * import actually reads is the lifted top-level `payload.env`, not
 * `workspace.env`. This half is only the message.
 *
 * A DEFAULT makes some prior intent inexpressible unless it is observable, so
 * the three states read differently even when two of them send nothing: values
 * came from a named file, no file was found, or nothing is declared at all.
 *
 * A name the config declares is an override; a name it does not is an addition,
 * and additions are warned about individually. Adding one is legitimate — a
 * secret CI knows about and the repo must not name — but it is also exactly what
 * a typo looks like, and this is the only place either becomes visible. Values
 * are never printed.
 */
/**
 * Where supplied values came from, credited to each real source — the file, the
 * repeatable flag that beats it, or both with a count apiece. `flagOnly` is the
 * phrase before the flag when it supplied everything.
 */
function suppliedFrom(
  fromFile: number,
  file: string,
  fromFlag: number,
  flag: string,
  flagOnly: string,
): string {
  if (fromFile > 0 && fromFlag > 0) return ` — ${fromFile} from \`${file}\`, ${fromFlag} from ${flag}.`;
  if (fromFile > 0) return ` from \`${file}\`.`;
  if (fromFlag > 0) return `${flagOnly} ${flag}.`;
  return ".";
}

function reportWorkspaceEnv(r: {
  declaredNames: readonly string[];
  resolution: EnvResolution;
  /** The file the values came from, or undefined when none was read. */
  source: string | undefined;
  /** How many of the values sent `--env-var` supplied, beating the file. */
  flagged: number;
  /** The names `--allow-empty-env` excuses, which partitions `clearing`. */
  allowed: ReadonlySet<string>;
  /** Whether this command refuses on what is left (deploy alone). */
  refuses: boolean;
  /** The default file this run looked for, for the branch that did not find it. */
  defaultLabel: string;
  /** A read-only comparison (`workspace diff`): nothing is imported, so nothing "will be" sent. */
  comparesOnly?: boolean;
  /** `release create`: the release carries no env, so an unsupplied name clears nothing anywhere. */
  cutsRelease?: boolean;
  /**
   * A merging deploy, by the flag that makes it one (`--keep-data`, or `--to`
   * without `--replace`): its env is add-only, so an empty value clears nothing
   * the target holds.
   */
  merges?: "`--keep-data`" | "`--to`";
}): void {
  const sent = Object.keys(r.resolution.values).length;
  // Partitioned HERE rather than passed in twice: one array and one predicate
  // cannot fall out of step with each other the way two arrays can.
  const cleared = r.resolution.clearing.filter((n) => r.allowed.has(n));
  const unsupplied = r.resolution.clearing.filter((n) => !r.allowed.has(n));
  if (r.declaredNames.length === 0 && sent === 0) {
    info("Workspace env: no env vars are declared and none were supplied.");
  } else if (sent > 0) {
    info(
      `Workspace env: ${countOf(sent, "value")}` +
        suppliedFrom(sent - r.flagged, r.source ?? r.defaultLabel, r.flagged, "--env-var", " supplied with"),
    );
  } else if (r.source !== undefined) {
    info(`Workspace env: 0 values from \`${r.source}\`.`);
  } else {
    // `clearing`, not `declaredNames`: a config that spells out its own values
    // supplies them, and saying they "have no value" sends the reader looking
    // for a problem that is not there.
    const empty = r.resolution.clearing.length;
    info(
      `Workspace env: no \`${r.defaultLabel}\` found` +
        (empty === 0
          ? r.declaredNames.length === 1
            ? `; the 1 declared value comes from the source.`
            : `; the ${r.declaredNames.length} declared values come from the source.`
          : empty === 1
            ? `; 1 declared name has no value.`
            : `; ${empty} declared names have no value.`),
    );
  }

  if (cleared.length > 0) {
    // `warn`, not `exportWarn`: the author asked for this by name, so it is an
    // advisory — counting it under --strict left no way to pass with an
    // intentionally empty declared name.
    const those = cleared.length === 1 ? "that name" : "those names";
    warn(
      r.comparesOnly === true
        ? `Workspace env: ${cleared.join(", ")} ${cleared.length === 1 ? "is" : "are"} compared as EMPTY (--allow-empty-env).`
        : r.merges !== undefined
          ? `Workspace env: ${cleared.join(", ")} will be sent EMPTY (--allow-empty-env). A ${r.merges} ` +
            `merge keeps whatever the target holds for ${those}, and adds ${cleared.length === 1 ? "it" : "them"} ` +
            `empty where it holds none.`
          : `Workspace env: ${cleared.join(", ")} will be sent EMPTY (--allow-empty-env). Whatever ` +
            `the target holds for ${those} is cleared.`,
      "workspace-env.compared-empty",
    );
  }
  // A merge lets an unsupplied name through: nothing it holds is cleared.
  if (unsupplied.length > 0 && r.merges === "`--keep-data`") {
    const one = unsupplied.length === 1;
    info(
      `Workspace env: ${unsupplied.join(", ")} ${one ? "has" : "have"} no value. A \`--keep-data\` merge ` +
        `keeps whatever the target holds for ${one ? "it" : "them"}, and adds ${one ? "it" : "them"} empty ` +
        `where it holds none.`,
    );
  }
  // Only for the commands that do NOT refuse — the refusal says it louder, and
  // saying it twice reads as two separate problems.
  if (unsupplied.length > 0 && !r.refuses && r.merges === undefined) {
    exportWarn(
      "workspace-env.unsupplied",
      r.comparesOnly === true
        ? `Workspace env: ${unsupplied.length === 1 ? `1 declared name is unsupplied (${unsupplied[0]})` : `${unsupplied.length} declared names are unsupplied (${unsupplied.join(", ")})`}, ` +
            `so this project's side of the comparison holds no value for ${unsupplied.length === 1 ? "it" : "them"}.`
        : r.cutsRelease === true
          ? `Workspace env: ${unsupplied.length === 1 ? `1 declared name is unsupplied (${unsupplied[0]})` : `${unsupplied.length} declared names are unsupplied (${unsupplied.join(", ")})`}. ` +
            `A release carries no env values, so this changes nothing it carries: set ` +
            `${unsupplied.length === 1 ? "it" : "them"} on each destination it lands on with \`xanosdk env set\`.`
        : (unsupplied.length === 1
            ? `Workspace env: 1 declared name is unsupplied (${unsupplied[0]}); this bundle will clear it ` +
              `if it is imported.`
            : `Workspace env: ${unsupplied.length} declared names are unsupplied (${unsupplied.join(", ")}); ` +
              `this bundle will clear them if it is imported.`) +
          ` Put the value${unsupplied.length === 1 ? "" : "s"} in \`${r.source ?? r.defaultLabel}\`, pass ` +
          `\`--env-var NAME=value\`, or — if empty is meant — \`--allow-empty-env=${unsupplied.join(",")}\`.`,
    );
  }

  if (r.resolution.additions.length > 0) {
    const added = r.resolution.additions;
    exportWarn(
      "workspace-env.undeclared",
      `Workspace env: ${added.join(", ")} ${added.length === 1 ? "is" : "are"} not declared in ` +
        `\`workspaceConfig({ env })\` and ${r.comparesOnly === true ? `${added.length === 1 ? "is" : "are"} supplied only by this project's env values (a deploy would add ${added.length === 1 ? "it" : "them"})` : "will be ADDED"}. Declare the name there with an empty ` +
        `value so the stack's \`env()\` reads stay checkable; if this is a typo, this is the ` +
        `only place you will see it.`,
    );
  }
}

/**
 * List the instance capabilities this bundle depends on.
 *
 * The editor greys these statements out on an instance that cannot run them;
 * the SDK authors against the whole catalog and finds out at request time. This
 * cannot check the TARGET — no CLI token exposes an instance's flag set — so it
 * states what the bundle NEEDS and leaves the comparison to a human. That is
 * worth doing because the failure it heads off is invisible until production: a
 * `promote` onto a plan that differs from the ephemeral it was built on.
 *
 * Informational, never a warning: on the ephemeral most people deploy to, every
 * line here is already satisfied. It goes to STDERR because stdout may be a
 * piped bundle.
 */
function reportCapabilities(bundle: unknown): void {
  const needs = bundleCapabilities(bundle);
  if (needs.length === 0) return;
  info(`This bundle needs ${needs.length} instance capabilit${needs.length === 1 ? "y" : "ies"}:`);
  for (const need of needs) {
    // Name one object per capability, not all of them: the point is to make the
    // requirement findable, and a workspace with forty redis calls would bury
    // the other lines.
    const where = need.objects.length
      ? ` (e.g. ${need.objects[0]}${need.objects.length > 1 ? ` +${need.objects.length - 1} more` : ""})`
      : "";
    detail(`${need.label} — ${need.effect}${where}`);
  }
  detail("Check these against the plan of anything you promote to; the deploy cannot.");
}

/**
 * The CLI's own export-time warnings this compile printed, recorded only under
 * `--strict` (reset by every `compileBundle`). The library's warnings reach
 * `--strict` through its diagnostic bag; these are printed by the CLI around
 * the export — documentation gates, workspace env, lock entries that match
 * nothing — and without this they exited 0 under a flag documented to fail on
 * every warning.
 */
let strictFindings: Array<{ code: AnyWarningCode; message: string }> | undefined;

/** The same warnings, recorded on every compile, with their codes. */
let exportFindings: Array<{ code: string; message: string }> = [];

/** `1 table`, `2 tables` — a count and its noun, agreeing. */
function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Print an export-time warning, record it for `--strict`, and carry it in this
 * run's `--json` document under `code` — a stable dotted name (`lock.orphan`,
 * `workspace-env.undeclared`) a script can match without parsing the sentence.
 * `remedies` are printed as detail lines under it and ride the JSON `message`
 * too: a reader of the document gets the fix-up commands stderr gave.
 *
 * Under `--strict` a finding is NOT printed here: every one recorded is refused
 * before the run can succeed, and the refusal lists it in full, remedies
 * included — printing it here too said each one twice (E2E pass 29). It still
 * reaches `--json`'s `warnings[]`.
 */
function exportWarn(
  code: AnyWarningCode,
  message: string,
  remedies: readonly string[] = [],
  /** False for a warning a flag of this run accepted: said, carried in `--json`, but not a `--strict` failure. */
  strict = true,
  /** What `--json` carries in place of the printed text — a capped list's full form. */
  machine?: string,
): void {
  const full = [message, ...remedies].join("\n");
  if (strict && strictFindings !== undefined) {
    strictFindings.push({ code, message: full });
    noteRunWarning(code, machine ?? full);
  } else {
    warn(message, code, remedies, machine);
  }
  exportFindings.push({ code, message: machine ?? full });
}

/**
 * Under `--strict`, fail on the export-time findings recorded so far — through
 * {@link strictRefusal}, the one shape every `--strict` refusal takes: numbered,
 * each finding in full with its remedies, the way out on its own line.
 */
function failStrictFindings(args: ParsedArgs, library: readonly Diagnostic[] = []): void {
  if (library.length > 0) throw strictRefusal(args, library);
  if (!args.strict || strictFindings === undefined || strictFindings.length === 0) return;
  throw strictRefusal(args, []);
}

/**
 * The one `--strict` refusal: the library's findings (the export's bag, and
 * warnings the entry raised as it loaded) and the CLI's own pending ones,
 * counted together and each listed in full — none of them was printed before.
 */
function strictRefusal(args: ParsedArgs, library: readonly Diagnostic[]): DiagnosticError {
  const all: Diagnostic[] = [];
  for (const d of [...library, ...takePendingStrictFindings()]) {
    if (!all.some((a) => a.code === d.code && a.message === d.message)) all.push(d);
  }
  const n = all.length;
  const hard = all.filter((d) => d.severity === "error").length;
  // The headline, the numbered findings, then the remedy on its own line.
  const why = hard === 0 ? "" : ` — ${countOf(hard, "error")}, and ${countOf(n - hard, "warning")} that --strict makes errors`;
  const remedy =
    hard === 0
      ? `Resolve ${n === 1 ? "it" : "them"}, or run without --strict to proceed with ${n === 1 ? "it" : "them"}.`
      : "Resolve them.";
  return new DiagnosticError(
    `\`${commandLabel(args)}\` stopped: ${countOf(n, "finding")} ${n === 1 ? "fails" : "fail"} --strict${why}\n` +
      // A finding's remedies are its later lines: each on its own line under it.
      all.map((d, i) => `  ${i + 1}. ${d.message.split("\n").join("\n     ")}`).join("\n") +
      `\n${remedy}`,
    all,
  );
}

/** A thunk's result with the diagnostic sink silenced; `undefined` when it throws. */
function quietly<T>(fn: (() => T) | undefined): T | undefined {
  if (fn === undefined) return undefined;
  const previous = setDiagnosticSink(() => {});
  try {
    return fn();
  } catch {
    return undefined;
  } finally {
    setDiagnosticSink(previous);
  }
}

/**
 * The CLI's own `--strict` findings still pending when the LIBRARY's strict
 * refusal fired first — they failed the run just as much, so they join
 * `details.diagnostics` beside it. Before, one sat in `details.diagnostics`
 * only when it was the lone cause, and in `details.warnings` otherwise
 * (E2E pass 27). Taken once: the pending list is emptied.
 */
function takePendingStrictFindings(): Array<{ severity: "warning"; code: AnyWarningCode; message: string }> {
  const pending = strictFindings ?? [];
  if (strictFindings !== undefined) strictFindings = [];
  return pending.map(({ code, message }) => ({ severity: "warning" as const, code, message }));
}

/**
 * Filter-name preflight: a `filter(name, …)` the engine can't
 * resolve exports clean, then 500s (`Unable to locate func entry`) on the first
 * live request. Warn per occurrence (STDERR — stdout may be a piped bundle),
 * pointing at the likely intended name; `--strict` promotes it to a hard failure.
 */
function checkFilterNames(bundle: unknown): void {
  for (const f of findUnresolvableFilters(bundle)) {
    const hint = f.suggestions.length ? ` — did you mean ${f.suggestions.map((s) => `\`${s}\``).join(" or ")}?` : "";
    exportWarn(
      "filter.unresolvable",
      `Filter "${f.name}" (in ${f.location}) is not engine-resolvable and will 500 at runtime${hint}`,
      [
        f.inExpression
          ? "Replace it with a resolvable name (see `fl.*` / llms.txt) where it is piped: the `filter()` inside the `obj()` member, or the `|name` in the `c.expression` source."
          : "Replace it with a resolvable name (see `fl.*` / llms.txt) or drop the raw `filter()` call.",
      ],
    );
  }
}

// NOTE: this module is the CLI *library* (it exports `run`/`parseArgs`/
// `loadDefault` for programmatic and test use). The process is driven by the
// dedicated `bin.ts` executable, which calls `run()` unconditionally. Earlier
// this file self-invoked via an `import.meta.url === process.argv[1]` guard,
// but the bundler code-splits shared code into a chunk — moving `import.meta.url`
// off the bin file — so the guard was always false and the published CLI did
// nothing. Keep execution in `bin.ts`; never reintroduce self-detection here.
