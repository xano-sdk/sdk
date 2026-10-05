/**
 * `xanosdk deploy` — compile-or-load a bundle and import it into an ephemeral
 * environment.
 *
 * **One destination, and no flag for it.** An ephemeral is its own Xano
 * environment at its own base URL, the caller's SAME OAuth token authenticates
 * there, and the import goes to `{base_url}/api:meta/workspace/1/xanosdk/import`
 * with `mode=replace` — a full clear-then-replace (reset is inherent; there is
 * no opt-out) through the SDK's own import route, which refuses an identity
 * collision rather than inventing a name for it. That is exactly
 * why there is nowhere else to send it: `.xano/ephemeral.json` names the active
 * tenant, which is GET-ed and create-or-refreshed — a live tenant is refreshed
 * (URL unchanged); a 404/expired one is recreated (the URL change is called
 * out).
 *
 * Nothing the server returns is written back into `xano.lock` — the env is a
 * different, throwaway workspace and reconciling its identities would pollute the
 * lock. Compiling an ENTRY FILE does maintain the local lock, by default and
 * unrelated to the deploy: the identities it records come from the CODE, so a
 * throwaway environment cannot leak into them. The one thing it does mean is
 * that an exploratory deploy freezes public URL slugs a later release will pin
 * — which is the point of writing them down, but worth knowing the first time
 * a disposable run leaves a file behind.
 *
 * `--static <dir>` deploys a frontend alongside the backend, into the EPHEMERAL
 * itself, so backend and frontend share one disposable environment. It is
 * published AFTER the workspace import, because the import's clear tears static
 * hosting down; a static failure never blocks the backend — it exits
 * distinctly instead.
 *
 * Node-only and lazily imported so the browser-safe authoring bundle stays clean.
 */
import { describeWrite, noteLanded } from "../util/sent-writes.js";
import { existsSync, realpathSync } from "node:fs";
import { passwordHashesWarning, passwordOrigin } from "./release-common.js";
import { missingLockDir, type ParsedArgs } from "./cli.js";
import type { KeepDataMergeRequest, KeepDataMergeResult } from "./keep-data-merge.js";
import { codePinnedTables, type CodePinnedTable, type LockFile } from "../lock/lock.js";
import { storedColumnsOf, withStoredColumns } from "../lock/landed.js";
import { readLockFile } from "../lock/io.js";
import type { TestRunSummary } from "./test-command.js";
import type { TestOutcome } from "../deploy/tests.js";
import type { Bundle } from "../workspace/export.js";
import {
  assertBundleFile,
  assertBundleInput,
  assertEntryFile,
  assertValueFiles,
  loadBundleText,
  refuseCompileValueFlags,
  compileValueFlagKinds,
  DOC_TOKEN_REMEDY,
  refuseValueFlagsBesideBundle,
} from "./bundle-input.js";
import type { NonPublicSeedValue, SeedSourceKind } from "../workspace/seed.js";
import { getAccessToken, type BearerTarget, type ResolvedAuth } from "../auth/token.js";
import { encodeWorkspaceArchive, decodeWorkspaceArchive, archiveHostedFiles } from "../validate/archive.js";
import { HostedFilesUnresolvedError, ImportNotSentError, XanoSdkImportRefusal, xanosdkImport } from "../deploy/xanosdk-import.js";
import {
  createEphemeral,
  listEphemeral,
  renameEphemeral,
  getEphemeral,
  waitUntilReady,
  isUnansweredPoll,
  isExpired,
  isEphemeralDisabled,
  namedEphemeral,
  type EphemeralSummary,
} from "../deploy/ephemeral.js";
import {
  readEphemeralState,
  getEnvironment,
  setEnvironment,
  markEnvironmentFilled,
  recordStaticUrl,
  ephemeralLandedOn,
  ephemeralLandingKey,
  ephemeralStatePath,
  environmentKey,
} from "../deploy/ephemeral-state.js";
import { recordDeployed } from "../deploy/deployed-state.js";
import {
  assertStaticHostExists,
  EXIT_STATIC_FAILED,
  noteStaticTakenDown,
  readFrontendsAfterFailure,
  readStaticTeardown,
  recheckDoubtedFrontend,
  staticAfterFailedReplace,
  refuseStaticHostAReplaceClears,
  staticRemovedField,
  staticRetryCommand,
  unknownStaticOutcome,
  staticRetryHint,
  warnStaticTeardown,
  type FrontendAfterFailure,
  type StaticTeardown,
} from "./static-teardown.js";
import { shellQuote } from "../util/shell-quote.js";
import { activeOperation, EXIT_OUTCOME_UNKNOWN, registerOperation } from "./operation-registry.js";
import { certificateFailureCode, closeSentence, SENT_AFTERMATH, TransportError, withoutReadAftermath } from "../util/http.js";
import { andList } from "../util/and-list.js";
import { pipedYes, retryCommand, withheldNote, yesRerun, type RetryCommand } from "./retry-command.js";
export { retryCommand, withheldNote, yesRerun, type RetryCommand } from "./retry-command.js";
import { engineNameForProject, getEngineRecord } from "../deploy/local-engine-state.js";
import type { Source } from "./source-selector.js";
import { lookupEphemeral, type CredentialProvider } from "./source-resolve.js";
import { selectDeployArm, type DeployArm, type KeepDataSkipped } from "../deploy/keep-data.js";
import type { SeedContentFile } from "../workspace/seed.js";
import type { LocalEngineOverride, LocalEnginePinOutcome } from "./local-engine-choice.js";
import {
  isAwaited,
  waitForMicroservices,
  type MicroserviceSummary,
  type WaitOptions,
} from "../deploy/microservice-status.js";
import { microserviceLine, readyRatio } from "./microservice-view.js";
import {
  step,
  success,
  warn,
  detail,
  blank,
  info,
  link,
  spinner,
  type Spinner,
  withSpinner,
  formatExpiration,
  elapsedSuffix,
  credentialWriteTarget,
  discloseWriteTarget,
  writeTargetPayload,
  backendDestinationPayload,
  type LocalEngineTarget,
  type WriteTarget,
} from "./ui.js";
import { isMachineOutput, writeJson } from "./output.js";
import { DEFAULT_PROFILE, type ProfileSelection } from "../auth/profile-select.js";
import { CliError, LocalFileNotFoundError, statesOutcomeUnknown, UsageError } from "./errors.js";
import { otherCredentialRefusal, type MetaTarget } from "./env-target.js";
import { openBrowser } from "../auth/loopback.js";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { displayPath } from "../util/rel-path.js";
import type { HeldLock } from "../util/file-lock.js";
import { contextFlags, credentialFileOf } from "./context-flags.js";
import { pastePath } from "./typed-cwd.js";
import { withArticle } from "../util/article.js";

/**
 * Exit code for a deploy whose microservices are not running (the backend import
 * itself succeeded).
 *
 * Same shape as {@link EXIT_STATIC_FAILED}: the deploy happened, and something it
 * deployed is not serving. A deploy that prints a URL and a ✓ over a dead
 * workload is not a successful deploy, and in CI that difference is only ever
 * carried by the exit code.
 */
const EXIT_MICROSERVICE_NOT_READY = 4;

/**
 * `--test` could not REACH the suite (the list route failed, the environment
 * never answered). Distinct from 5, which means the suite ran and disagreed:
 * a caller retries this one and investigates that one.
 */
const EXIT_TESTS_UNREACHABLE = 6;
/**
 * The `--static` publish, run once the environment's base URL is known.
 *
 * It runs AFTER the archive import: the static host lives in the very workspace
 * the import replaces, and the import's clear tears static hosting down.
 *
 * Must not throw: the backend deploy stands or falls on the import alone. A
 * failure resolves to a summary carrying `error` instead.
 */
type PublishStatic = (env: {
  baseUrl: string;
  label: string | undefined;
  name: string;
  /**
   * The publish after a failed replace, bringing the frontend back. Its failure
   * is said by the import's error (see `republishNote`), not by the
   * "backend deploy stands" warning — no backend deploy stands.
   */
  republish?: boolean;
}) => Promise<StaticPublishSummary>;

/**
 * How hard the post-import microservice read is asked to look, and how much of
 * its answer is allowed to fail the deploy.
 *
 * Two independent questions rather than one tri-state: `skip` drops the read
 * entirely, and `requireReady` decides whether "not ready yet" is a failure —
 * a microservice the engine reports as FAILED exits non-zero either way.
 */
export interface MicroserviceCheck {
  skip: boolean;
  requireReady: boolean;
  /** `ephemeral:<name>` for the re-check hint, when the caller knows it. */
  name?: string;
  /** This run's credential flags, for the re-check hint (see `contextFlags`). */
  flags?: string;
  /** Told when the status could not be read — for the summary's `microservicesError`. */
  onReadError?: (error: MicroservicesError) => void;
}

/** Why the microservice status could not be read after a landed deploy, and the command that reads it. */
export interface MicroservicesError {
  message: string;
  /** The read-only command that checks them: `xanosdk ephemeral get <name>`. */
  remedy: string;
}


/** The check a parsed command line asks for. */
function microserviceCheck(args: ParsedArgs): MicroserviceCheck {
  return { skip: args.skipLiveness, requireReady: args.requireMicroservices };
}

export type { LocalEnginePinOutcome };

export interface DeploySummary {
  /**
   * Which kind of backend this deploy landed on. Constant per arm, and kept
   * anyway: a wrapper reading this document should not have to know from
   * context which backend it describes, and the field is the only thing in it
   * that says so. `kind` because that is the one field name for a backend kind
   * in every machine document — the same spelling the selector grammar uses.
   */
  kind: "ephemeral" | "local";
  /**
   * The backend this run wrote to, in the one shape every writing command uses.
   *
   * `{ instance, workspaceId, kind, label, url }`: the PARENT — which instance,
   * which workspace the ephemeral was created under — because that is the
   * answer to "did this land in the right account"; `label` the environment's
   * bare name and `url` its own base URL. A Xano Engine has no parent, so its
   * `instance` is the engine's URL and it carries `local: true`. A `--json`
   * caller never sees the progress stream, so without this the write-target
   * disclosure would not reach the reader most likely to be automating against
   * the wrong credential.
   */
  destination: ReturnType<typeof writeTargetPayload> & { url?: string };
  /**
   * Which stored credential profile wrote this, and the rung that chose it.
   * Null on the environment-credential paths, which have no profile.
   *
   * The server's audit log is not ours to write, so this is where the CLI
   * records the answer to "who deployed to that tenant" — in the one document a
   * wrapper or a CI job already keeps.
   */
  profile: ProfileSelection | null;
  url: string | undefined;
  ephemeral?: { name: string; display: string | undefined; expiresAt: string | number | undefined };
  /**
   * The engine a `--local` deploy landed on. Present only on that
   * destination, under its OWN key: reusing `ephemeral` would hand a wrapper a
   * name it would then feed to `xanosdk ephemeral get`, which has no engine to
   * find and no way to say so.
   *
   * The log path is here because it is the only handle on an engine that has
   * gone wrong — nothing else in this document leads to one. The bearer is NOT,
   * anywhere: a Xano Engine's bearer is never recorded, and is printed only by
   * `xanosdk local token`, which a caller runs to ask for it — a summary
   * gets logged by CI whether anyone wanted the bearer or not. Neither is the
   * sign-in URL, which may be shown to a person and still opens an owner
   * session.
   */
  engine?: {
    name: string;
    workspaceId: number;
    logPath: string;
    /**
     * The serving engine's version: the release it resolved to (`v0.1.5`), or
     * an override binary's own report. Absent only when an override could not
     * report one.
     */
    engineVersion?: string;
    /**
     * What this run did to the project's pinned engine version in
     * `package.json`: `created` (first run pinned it), `moved` (an update was
     * accepted), `unchanged` (a pin was read and kept), or `none` (no pin is in
     * play — an override on the flag or in XANOSDK_ENGINE_OVERRIDE, a
     * custom XANOSDK_ENGINE_RELEASES_URL, or a deploy from a directory with no
     * `package.json` that is not a project either).
     * `created` includes creating a `package.json` to hold the pin when the
     * project had none.
     */
    pin: LocalEnginePinOutcome;
    /**
     * Present only when this run served an override rather than the pin — the
     * one thing `pin: "none"` cannot say on its own: `flag` (`--local=`),
     * `env` (XANOSDK_ENGINE_OVERRIDE), or `releases-url` (a custom
     * XANOSDK_ENGINE_RELEASES_URL).
     */
    override?: LocalEngineOverride;
  };
  created?: boolean;
  /**
   * What happened to the environment's table rows: `kept` when `--keep-data`
   * merged into what an earlier deploy filled, `replaced` otherwise — which is
   * every deploy without the flag.
   */
  data: "kept" | "replaced";
  /**
   * Present only when `--keep-data` was asked for and the deploy replaced
   * anyway, saying why: `new` (nothing recorded to keep), `recreated` (the
   * recorded environment is gone — expired, or the engine restarted),
   * `never-filled` (no earlier import into it completed), or `reset`.
   */
  keepDataSkipped?: KeepDataSkipped;
  /**
   * What a `--keep-data` merge deleted because the project no longer declares
   * it — each present only when it names something, and the same lists the
   * merge prints on stderr, which a `--json` reader never sees. Tables go with
   * every row in them; a dropped column with its values; a retyped column
   * (`{ table, column, from, to }`) keeps every value it holds, unconverted.
   * `removed` is every other object, labelled `<sdkKind>:<name>`.
   * `notLanded` names those of them (tables as `table:<name>`) this project's
   * landing record for the ephemeral does not name: another source landed
   * them, and a keep-data merge mirrors this project's source.
   */
  droppedTables?: string[];
  droppedColumns?: string[];
  /** Tables a merge dropped columns from and added others to (`{ table, dropped, added }`): not a rename — the dropped values are gone. */
  pairedColumns?: Array<{ table: string; dropped: readonly string[]; added: readonly string[] }>;
  retypedColumns?: Array<{ table: string; column: string; from: string; to: string }>;
  /** Columns a merge made nullable whose physical NOT NULL it keeps (`table.column`); `--reset` relaxes them. */
  notNullKept?: string[];
  /** Enum columns a merge kept with values removed (`{ table, column, removed }`): a row holding one reads null. */
  narrowedEnums?: Array<{ table: string; column: string; removed: readonly string[] }>;
  /** Table references a merge pointed at another table (`{ table, column, from, to }`); the ids rows hold are kept. */
  retargetedRefs?: Array<{ table: string; column: string; from: string; to: string }>;
  /** Indexes a merge added or dropped (`{ table, index, action, unique }`). */
  indexChanges?: Array<{ table: string; index: string; action: "add" | "drop"; unique: boolean }>;
  /** Columns a merge made non-nullable (`{ table, column, type }`): a row holding null reads the type's empty value. */
  notNullTightened?: Array<{ table: string; column: string; type: string }>;
  removed?: string[];
  notLanded?: string[];
  /**
   * Present only when a `--keep-data` merge CREATED tables whose seed rows it
   * did not write: a merge writes no rows, so these start empty. `--reset`
   * seeds them (and replaces every other table's rows with its seeds too).
   */
  unseededTables?: string[];
  /**
   * Present only when a `--keep-data` merge renamed tables in place (`lock
   * rename` kept their identity), each `{ from, to }` — their rows are kept.
   */
  renamedTables?: Array<{ from: string; to: string }>;
  /**
   * Present only when a `--keep-data` merge left workspace documentation
   * fields as they are live: a merge does not write that block.
   */
  unappliedDocumentation?: ("require_token" | "token")[];
  /**
   * Present only when a `--keep-data` merge left env vars at their live value
   * where the project's differs: a merge does not update values. Names only.
   * The same key `deploy --to workspace` reports them under.
   */
  unchangedEnv?: string[];
  /**
   * Present only when a `--keep-data` merge moved public URL slugs (a pinned
   * `canonical` changed in code), each `{ kind, name, from, to }`: every
   * endpoint under `from` stops answering.
   */
  canonicalChanges?: Array<{ kind: string; name: string; from: string; to: string }>;
  static?: StaticPublishSummary;
  /**
   * What this deploy recorded as landed on the ephemeral (the scope of a later
   * `deploy --to ephemeral:<it> --prune`), in the shape `deploy --to`,
   * `tenant deploy` and `promote` report it; `null` when nothing was recorded —
   * a Xano Engine keeps none.
   */
  landingRecord?: import("./landing-record.js").LandingReport | null;
  /**
   * Present only when this deploy REPLACED an environment a frontend was
   * serving from: the URLs that stopped serving (less one `--static` served
   * again), read from the platform — `verified: false` when that read failed
   * and the URL is this project's record of its last publish. A replace clears
   * static hosting; `--static` republishes it (the URL may change).
   */
  staticRemoved?: StaticTeardown;
  /**
   * Present only when a flag was accepted and could not be acted on — today
   * `--expires-hours` on an ephemeral that already exists, whose lifetime is
   * set only when it is created.
   */
  notApplied?: string[];
  /** Present only when the deployed workspace declared microservices. */
  microservices?: MicroserviceSummary[];
  /**
   * Present only when their status could not be read after the deploy landed:
   * why, and the command that reads it. Without it an unread status and a
   * workspace with no microservices looked the same.
   */
  microservicesError?: MicroservicesError;
  /** Present only under `--test`: the suite that ran against what was just deployed. */
  testRun?: DeployTestSummary;
  /**
   * Toolchain modules the project depends on but never configured, if any.
   *
   * These run on their own defaults with nothing this project chose, because
   * absent config reads as ENABLED — so a module that arrived by a plain
   * `npm install` or a merged PR fires its hooks with `config: {}` and the
   * deploy this document describes was built with it.
   *
   * It is warned about on stderr on every discovery. Here as well because that
   * is the wrong channel for the reader this document has: a CI job piping
   * stdout sees the summary and not the warning, which is exactly the caller
   * least likely to have a human watching the other stream.
   *
   * Omitted rather than emitted empty, so the field's presence is the signal.
   *
   * Deliberately unlike `marketplace install|reinstall|remove --json`, which
   * always carries `unconfigured` even when it is empty. The documents answer
   * different questions. A marketplace verb's document REPORTS ON A RECONCILE
   * the reader just asked for, so "nothing was left unconfigured" is an answer
   * and the key is always there. This one describes a DEPLOY, where the state
   * is incidental to what was asked — most deploys have nothing to say about
   * it, and a key that is present on every one of them stops being a signal.
   */
  unconfigured?: string[];
  /**
   * Present only when a seeded release replaced the rows of an environment
   * other than the one it was cut from, and carried password hashes: the
   * `table.column`s whose logins fail there as a bad password. A hash is
   * keyed to the environment that made it, and no release carries the key.
   */
  passwordHashesUnverifiable?: string[];
}

/**
 * The `--test` result folded into the deploy summary, under `testRun`.
 *
 * `testRun` rather than `tests`, and `tests` rather than `results` inside it, so
 * that ONE rule covers every test-bearing document the CLI emits: the per-test
 * array is always called `tests`, and nothing else is. A script walking a deploy
 * summary for the first `tests` key used to land on this wrapper OBJECT and find
 * no array in it.
 */
export interface DeployTestSummary {
  /** The whole suite: `passed + failed + notRun` — the shape `test run-all` reports. */
  total: number;
  passed: number;
  failed: number;
  /** Tests never reached because the suite stopped answering; 0 on a run that finished. */
  notRun: number;
  /** With `notRun`: those tests, as `test run` takes them. */
  unreachable?: string[];
  /** Each test as `test run` reports it — `object` names what a unit test hangs off. */
  tests: TestRunSummary["tests"];
  /**
   * Present only when the suite could not be run to the end (exit 6): why.
   * `tests` and the counts are then what DID run before it stopped — a partial
   * suite, never the whole one.
   */
  error?: string;
  /** With `error`: the `xanosdk test run-all` that runs the suite again — the deploy needs no repeat. */
  retry?: string;
}

/**
 * Build the static-host config globals: the backend URL is seeded as `XANO_HOST`,
 * then the caller's `--static-env` pairs override/extend it. Exported for tests.
 */
export function buildStaticEnv(baseUrl: string | undefined, staticEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  if (baseUrl) env.XANO_HOST = baseUrl;
  Object.assign(env, staticEnv);
  return env;
}

/** A value that is a publishable (browser-safe) key by its prefix: `pk_test_…`, `pk_live_…`. */
const PUBLISHABLE_KEY_VALUE = /^pk_(test|live)_/;
/** A value that is a secret or restricted key by its prefix: `sk_live_…`, `rk_test_…`. */
const SECRET_KEY_VALUE = /^(sk|rk)_(test|live)_/;

/**
 * `--static-env` pairs are baked into a PUBLIC static site's config — every
 * visitor can read them, which is why help says "never secrets". A key that
 * reads like one is warned about rather than refused, and the name is only a
 * heuristic — so what says PUBLIC is not flagged: a name containing `PUBLIC` or
 * `PUBLISHABLE` (`PUBLIC_API_KEY`), or a value carrying a publishable-key prefix
 * (`pk_test_…`, `pk_live_…`) whatever it is named. A value carrying a SECRET-key
 * prefix (`sk_live_…`, `rk_test_…`) is flagged whatever it is named. Shared by
 * `deploy --static-env` and `publish --static-env`. Returns the keys warned on;
 * the printed warning is carried in the run's `--json` `warnings[]`.
 */
export function warnSecretLookingStaticEnv(staticEnv: Record<string, string>): string[] {
  const flagged = Object.entries(staticEnv)
    .filter(([key, value]) => {
      if (SECRET_KEY_VALUE.test(value)) return true;
      if (PUBLISHABLE_KEY_VALUE.test(value) || /PUBLIC|PUBLISHABLE/i.test(key)) return false;
      return /SECRET|TOKEN|KEY|PASSWORD|PRIVATE/i.test(key);
    })
    .map(([key]) => key);
  if (flagged.length === 0) return flagged;
  const one = flagged.length === 1;
  const message =
    `--static-env ${flagged.join(", ")} ${one ? "looks" : "look"} like ${one ? "a secret" : "secrets"}. ` +
    `Every --static-env value is published in the static site's config, readable by anyone who loads it — ` +
    `keep secrets in the backend's environment variables instead.`;
  warn(message, "static-env.secret-like");
  return flagged;
}

/**
 * Best-effort display name for an auto-created ephemeral: the release's name
 * when one is deployed (`source` is `release:<name>` — a release archive names
 * no workspace, so this fell through to the directory), else the workspace
 * name baked into the bundle, else the project directory basename. `--name`'s
 * help states this rule.
 */
export function deriveDisplay(bundleText: string, cwd: string, source?: string): string {
  if (source !== undefined && source.startsWith("release:") && source.length > "release:".length) {
    return source.slice("release:".length);
  }
  try {
    // `payload.workspace` is the workspace settings object (`{ name, ... }`);
    // tolerate an array shape defensively.
    const parsed = JSON.parse(bundleText) as { payload?: { workspace?: unknown } };
    const w = parsed.payload?.workspace;
    const name = Array.isArray(w)
      ? (w[0] as { name?: unknown } | undefined)?.name
      : (w as { name?: unknown } | undefined)?.name;
    if (typeof name === "string" && name.trim() !== "") return name;
  } catch {
    /* fall through to the directory name */
  }
  return basename(cwd) || "xanosdk-app";
}

/**
 * Refuse to publish a static build that carries seed values the schema declares
 * non-public — or a static directory that cannot be published at all (missing,
 * not a directory, empty), which is checked first.
 *
 * Deploy is the one moment both halves are in hand — the rows about to be
 * imported and the assets about to be served — so this is the only place the
 * check can be made without being told about both separately.
 *
 * Only `access: "internal"`, `sensitive: true` and password columns are
 * considered. A public column's seed value is already readable through the
 * deployed API, so finding it in a bundle is not a disclosure, and refusing on
 * it would train people to reach for the override.
 *
 * The exception lives in the schema — `table({ publicSeed: [...] })` — not on
 * the command line: a flag has to be repeated by every caller that deploys the
 * project (a script, CI, an IDE preview), and the one that forgets it fails.
 * A declared column never reaches `values`.
 */
export async function assertNoSeedLeaks(
  dir: string,
  values: readonly NonPublicSeedValue[],
  /** `serverRendered`: the destination runs the build's server half (see `assertStaticDir`). */
  opts: { serverRendered?: boolean } = {},
): Promise<void> {
  // Lazily imported for the same reason the upload is: the static-host module
  // pulls in node:fs/node:zlib and must stay out of the authoring bundle.
  const { assertStaticDir, findSeedLeaks, StaticDirError } = await import("../deploy/static-host.js");
  // The directory itself first, and here rather than at upload time: the upload
  // runs AFTER the backend import, so a missing or empty `--static` directory
  // found only there has already replaced the environment's rows and taken its
  // old frontend down. Every caller that scans reaches this before its first write.
  // A wrong `--static` value is fixed by retyping it, so it is a usage error.
  try {
    assertStaticDir(dir, "--static", undefined, opts);
  } catch (err) {
    // A directory that is not there at all is a usage error (exit 1), as every missing local input is.
    if (err instanceof StaticDirError) {
      throw new (existsSync(dir) ? UsageError : LocalFileNotFoundError)(`${err.message} Nothing was deployed.`, {
        hintFor: { command: "deploy" },
      });
    }
    throw err;
  }
  if (values.length === 0) return;
  // Values the scan cannot look for: too short to search a build for without
  // matching everything, or not a string at all. They are NOT safe — the floor
  // exists to keep the scanner honest, not to classify the data — so say so
  // rather than let `--static` pass as though they had been checked.
  // Reported per COLUMN, not per row: one guarded column across 500 seed rows is
  // one thing for the author to look at, not 500 identical lines.
  const unscannable = [
    ...new Set(values.filter((v) => v.scannable === false).map((v) => `${v.table}.${v.column}`)),
  ];
  if (unscannable.length > 0) {
    warn(
      `${unscannable.length} non-public seed column${unscannable.length === 1 ? " holds a value" : "s hold values"} the static scan cannot search ` +
        `for — too short to match on, or not text at all — so they were NOT checked. Being ` +
        `unsearchable is not being safe: if any of these is a real credential, shorten the ` +
        `exposure rather than the value.`,
      "static-env.unscannable-seed",
      unscannable,
    );
  }
  const leaks = findSeedLeaks(dir, values);
  if (leaks.length === 0) return;

  // Per TABLE, because how a value reached the build depends on how the table
  // supplies its seed — and a wrong guess sends the author to fix code that is
  // already right.
  const columnsByTable = new Map<string, Set<string>>();
  for (const l of leaks) columnsByTable.set(l.table, (columnsByTable.get(l.table) ?? new Set()).add(l.column));
  const sourceOf = new Map(values.map((v) => [v.table, v.source]));
  const causes = [...columnsByTable.keys()].map((t) => seedLeakCause(t, sourceOf.get(t) ?? "inline"));
  const declarations = [...columnsByTable].map(
    ([t, cols]) => `  table "${t}": publicSeed: [${[...cols].map((c) => JSON.stringify(c)).join(", ")}]`,
  );

  throw new CliError(
    "SDK_SEED_IN_STATIC",
    `Refusing to publish: the static build in "${dir}" contains seed values from columns ` +
      `your schema marks non-public. These would be served at a public URL.\n` +
      `${leaks.map((l) => `  ${l.file} — ${l.table}.${l.column}`).join("\n")}\n\n` +
      `${causes.join("\n")}\n\n` +
      `If these values are deliberately public (a demo login the frontend shows), declare them on the table:\n` +
      declarations.join("\n"),
    { details: { leaks } },
  );
}

/** How a table's seed value reached a frontend build, for the refusal. */
function seedLeakCause(table: string, source: SeedSourceKind): string {
  switch (source) {
    case "thunk":
      return (
        `"${table}" seeds with \`() => import(...)\`, and a bundler follows that import into the ` +
        `frontend build. Use \`seedFile("./seed.json", import.meta.url)\` instead, then rebuild the frontend.`
      );
    case "inline":
      return (
        `"${table}" writes its seed rows inline, so a frontend that imports the table definition ` +
        `bundles them. Move them to \`seedFile("./seed.json", import.meta.url)\`, then rebuild the frontend.`
      );
    case "file":
      return (
        `"${table}" reads its seed with \`seedFile\`, which no bundler follows: the value is in the ` +
        `frontend's own source or something it imports. Remove it there, then rebuild the frontend.`
      );
  }
}

/**
 * Where an ephemeral deploy writes, for the shared disclosure emitter.
 *
 * The PARENT workspace, not the environment's own: the ephemeral does not exist
 * yet when this is said, and the account-level mistake the line exists to catch
 * is which parent a throwaway is being created under. The environment's own base
 * lands in the summary's `url` once the server has named it.
 *
 * Read off the credential here, unlike every other adopter — for this one
 * command the credential IS the destination, because an ephemeral is created
 * inside the workspace the credential is bound to and nowhere else.
 */
function ephemeralParent(auth: ResolvedAuth): WriteTarget {
  return credentialWriteTarget(auth);
}

/**
 * Run the just-deployed environment's tests and fold the result into the summary.
 *
 * The target is built from what the deploy already knows rather than re-resolved
 * from the environment's name: its base URL and its internal workspace id of 1
 * are both in hand, and re-deriving the env by NAME would go through the local
 * state file — which records the tenant the deploy tracked, not necessarily the
 * one this invocation just produced.
 *
 * ## Never throws
 *
 * Not for a failing test, and not for an unreachable one either. By the time
 * this runs the deploy has ALREADY happened, so anything escaping here would
 * skip the summary that carries the environment's URL — the CLI would exit
 * reporting nothing deployed for an environment that is live, which is the
 * opposite of what happened.
 *
 * The two outcomes stay distinguishable by exit code: {@link EXIT_TESTS_FAILED}
 * means the suite ran and disagreed, {@link EXIT_TESTS_UNREACHABLE} means it
 * could not be read at all. A caller investigates the first and retries the
 * second. Owning this here rather than at the call site means a future second
 * caller cannot forget the wrapper.
 */
export async function runDeployedTests(
  auth: BearerTarget,
  summary: DeploySummary,
  args: ParsedArgs,
): Promise<DeployTestSummary | undefined> {
  // What ran before the suite became unreachable: kept, so the `--json` reader
  // sees the passed unit test as well as why the rest did not run.
  const settled: TestOutcome[] = [];
  // What the suite never reached once it stopped answering, as `test run` names them.
  const notRun: string[] = [];
  try {
    return await runTestsOrThrow(auth, summary, args, settled, notRun);
  } catch (err) {
    // Without a read's "Nothing was changed — retry.": the deploy landed, so
    // "retry" read as "deploy again". What to retry is the suite, named below.
    const { isSuiteUnreachable, suiteUnreachableCheck } = await import("./test-command.js");
    const message = err instanceof Error ? err.message : String(err);
    // An unanswered run's "may or may not have taken effect — check before
    // retrying" is a write's aftermath: a test run is safe to repeat, and the
    // check that matters is the backend's, named below — as `test run-all`
    // names it for the same failure.
    const reason = isSuiteUnreachable(err)
      ? `${message.split("\n")[0] ?? message}\n${suiteUnreachableCheck(
          summary.engine !== undefined
            ? { kind: "local", env: summary.engine.name }
            : { kind: "ephemeral", env: summary.ephemeral?.name ?? null },
          args,
        )}.`
      : withoutReadAftermath(message);
    const again = testRunAllCommand(summary, args);
    // The rerun is a remedy line, so `--json`'s warning carries it (E2E pass 29).
    warn("The deploy stands, but its tests could not be run:", "deploy.tests-not-run", [
      reason,
      ...(again !== undefined ? [`Run them again once it is reachable with \`${again}\` — the deploy itself does not need repeating.`] : []),
    ]);
    process.exitCode = EXIT_TESTS_UNREACHABLE;
    return { ...(await testSummaryOf(settled, notRun)), error: reason, ...(again !== undefined ? { retry: again } : {}) };
  }
}

/**
 * `xanosdk test run-all` against the backend this deploy landed on, with the
 * run's own `--kind`/`--concurrency` and credential flags — the suite `--test`
 * would have run. A Xano Engine takes no credential flags. Undefined when the
 * summary names no backend to point it at.
 */
export function testRunAllCommand(summary: DeploySummary, args: ParsedArgs): string | undefined {
  const on =
    summary.engine !== undefined
      ? `local:${shellQuote(summary.engine.name)}`
      : summary.ephemeral?.name !== undefined
        ? `ephemeral:${shellQuote(summary.ephemeral.name)}`
        : undefined;
  if (on === undefined) return undefined;
  const kind = args.kind !== undefined ? ` --kind ${args.kind}` : "";
  const concurrency = args.concurrency !== undefined ? ` --concurrency ${args.concurrency}` : "";
  const flags = summary.engine !== undefined ? "" : contextFlags(args);
  return `xanosdk test run-all --on ${on}${kind}${concurrency}${flags}`;
}

/** The document's `testRun` for these outcomes, each as `test run` reports it. */
async function testSummaryOf(outcomes: readonly TestOutcome[], notRun: readonly string[] = []): Promise<DeployTestSummary> {
  const { suiteCounts, testRow } = await import("./test-command.js");
  return { ...suiteCounts(outcomes, notRun), tests: outcomes.map(testRow) };
}

/** The body of {@link runDeployedTests}, which owns the no-throw contract. */
async function runTestsOrThrow(
  auth: BearerTarget,
  summary: DeploySummary,
  args: ParsedArgs,
  settled: TestOutcome[],
  notRun: string[],
): Promise<DeployTestSummary | undefined> {
  const { runSuite, printTally, noTestsFound, EXIT_TESTS_FAILED } = await import("./test-command.js");
  const { qualifiedName } = await import("../deploy/tests.js");

  if (summary.url === undefined) {
    warn("Skipped --test: the ephemeral reported no base URL to run against.", "deploy.tests-not-run");
    return undefined;
  }
  // Read off the summary rather than taken as a parameter, so the destination
  // that wrote the document is the destination the suite runs against — a local
  // engine stands up its OWN workspace, and running its tests against a
  // hard-coded 1 would be a guess about someone else's backend.
  const local = summary.engine;
  const name = summary.ephemeral?.name;
  const target: MetaTarget = local
    ? { base: summary.url, workspaceId: local.workspaceId, label: `Xano Engine "${local.name}"` }
    : {
        base: summary.url,
        workspaceId: 1,
        // Named as `test run-all` names it: `ephemeral "x" ("Display")`.
        label: name ? namedEphemeral({ name, display: summary.ephemeral?.display }) : "the ephemeral",
        env: name,
      };

  // Forwarded, not dropped: both flags parse and validate globally, so a
  // `--test --kind workflow --concurrency 8` that silently ran the whole suite
  // serially would be exactly the quietly-ignored flag this CLI refuses to have.
  // A suite that stops answering part-way stops the run, as `test run-all`
  // does: what was read is kept, the rest is counted and named as not run, and
  // the same tally is printed (E2E pass 29: no tally, `total` the read count).
  let stopped: Error | undefined;
  const outcomes = await runSuite(auth, target, {
    kind: args.kind,
    concurrency: args.concurrency,
    onOutcome: (o) => settled.push(o),
    onUnreachable: (handle, err) => {
      stopped ??= err;
      notRun.push(qualifiedName(handle));
    },
  });
  if (stopped !== undefined) {
    if (outcomes.length > 0) {
      blank();
      const read = await testSummaryOf(outcomes, notRun);
      printTally(read.passed, read.failed, read.notRun);
    }
    throw stopped;
  }
  const run = await testSummaryOf(outcomes);

  // Progress, so on stderr in both output modes; the summary document carries
  // the same counts under `testRun`.
  blank();
  if (outcomes.length === 0) detail(await noTestsFound(auth, target, args.kind, " in the deployed environment"));
  else printTally(run.passed, run.failed);

  // Wins over a static-upload failure already recorded: a caller reading exit 5
  // checks the summary for the rest, and "a test failed" is the more actionable
  // of the two. The flag's help says so.
  if (run.failed > 0) process.exitCode = EXIT_TESTS_FAILED;

  return run;
}

/**
 * Keep the backend secret files this deploy just read out of git — `xano/.env`
 * and `xano/.secrets.json` — and SAY when one was not.
 *
 * Only the writers (`env pull`, `pull`, `secrets fill`) added the ignore rule,
 * so a hand-made file — the one the guides tell people to create — was read by
 * every deploy and sat one `git add .` from committing its secrets. Asked of
 * git, and only when git answers a definite "not ignored": outside a
 * repository there is nothing to commit it to. A warning, then the writers'
 * own rule and "Added … to .gitignore" line; the file is already on disk, so a
 * `.gitignore` failure is said, never fatal. A file git already TRACKS is past
 * what a rule can fix, so the warning names `git rm --cached` instead.
 *
 * A file a flag named (`--backend-env-file`, `--secrets-file`) is the
 * caller's choice, often outside the tree (CI), and `--bundle` reads neither —
 * none of those is touched. Exported for `deploy --to`, which reads the same
 * two files.
 */
export async function ignoreBackendSecretFilesRead(
  args: Pick<ParsedArgs, "envFile" | "secretsFile" | "bundle" | "file">,
): Promise<void> {
  if (args.bundle !== undefined || args.file === undefined) return;
  const paths: string[] = [];
  if (args.envFile === undefined) {
    const { defaultWorkspaceEnvPath } = await import("./workspace-env.js");
    paths.push(defaultWorkspaceEnvPath(args.file));
  }
  if (args.secretsFile === undefined) {
    const { defaultWorkspaceSecretsPath } = await import("./secrets-file.js");
    paths.push(defaultWorkspaceSecretsPath(args.file));
  }
  const { gitSaysIgnored } = await import("../auth/store.js");
  const { ensureSecretPathGitignored, refuseIfTracked, secretPathLabel } = await import("./gitignore.js");
  for (const path of paths) {
    if (!existsSync(path)) continue;
    if (gitSaysIgnored(path) !== false) continue;
    // From where the user typed: it is spelled into `git rm --cached`, and a
    // nested backend's `suites/alpha/xano/.env` called `xano/.env` there
    // untracks the root backend's file instead.
    const label = secretPathLabel(path);
    let tracked = false;
    try {
      refuseIfTracked(path, label);
    } catch {
      tracked = true;
    }
    if (tracked) {
      warn(
        `${label} holds secrets and is tracked by git — an ignore rule cannot untrack it. ` +
          `Run \`git rm --cached ${label}\` (it stays on disk) and commit that.`,
        "secrets.tracked-by-git",
      );
      continue;
    }
    warn(`${label} holds secrets and git was not ignoring it.`, "secrets.not-ignored");
    ensureSecretPathGitignored(path);
  }
}

/**
 * The verb that lands a release on this `--to` destination, for the line that
 * names the recorded path: `promote` lands one on the workspace, `tenant
 * deploy` on a tenant, and `deploy release:<name>` on an ephemeral — naming
 * `promote` for a tenant sent the reader to a verb that never touches it.
 * Exported for tests.
 */
export function recordedLanding(
  dest: { kind: "workspace" } | { kind: "tenant"; name: string },
  isEphemeral: boolean,
  /** This run's credential flags: the command reads the same account the run did (see `contextFlags`). */
  flags = "",
): string {
  if (dest.kind === "workspace") return `\`xanosdk promote <name>${flags}\``;
  if (isEphemeral) return `\`xanosdk deploy release:<name> --ephemeral${flags}\``;
  return `\`xanosdk tenant deploy ${shellQuote(dest.name)} <name>${flags}\``;
}

/**
 * How to keep what a `--to` run just landed as a release — a sequence that
 * genuinely stores it, each command runnable as printed.
 *
 * A release is cut on the instance from a backend that RAN there, and
 * `release create` with no `--from` cuts the project's tracked ephemeral — not
 * the destination this run wrote. So each destination gets its own answer:
 * the workspace and an ephemeral are cut from directly; a standard tenant
 * cannot be cut from at all, so the same source is deployed to the project's
 * ephemeral, cut there, and landed on the tenant with `tenant deploy`.
 *
 * Each `release create` it prints carries the run's own source (`--entry` or
 * `--bundle`), so the cut's drift comparison compiles what this run deployed.
 * A source that ships stored files (`hostedFile()`) gets no such sequence: a
 * release copies no file bytes, so `release create` refuses it — the deploy
 * itself is how to land it again.
 * Exported for tests.
 */
export function storeAsReleaseHint(
  dest: { kind: "workspace"; branch?: string } | { kind: "tenant"; name: string },
  isEphemeral: boolean,
  typed: { file?: string; bundle?: string },
  flags = "",
  /** The run's `--yes`: the landing verb confirms, and without it a run with no terminal refuses as printed. */
  yes = false,
  /** The landed source ships stored files a release cannot carry. */
  shipsFiles = false,
): string {
  if (shipsFiles) {
    return (
      "A release cannot keep this landing: the source ships stored files (`hostedFile()`), and a release " +
      "copies no file bytes, so `release create` refuses it. Re-run this deploy to land it again."
    );
  }
  const landed = "can be listed, exported and landed again";
  // Off a terminal the landing verb cannot ask, so `--yes` rides along there
  // too — a run that needed none of its own still prints one that runs.
  const land = recordedLanding(dest, false, `${yes || process.stdin.isTTY !== true ? " --yes" : ""}${flags}`);
  // What the cut compares against: this run's source, as typed.
  const against =
    typed.bundle !== undefined ? ` --bundle ${shellQuote(typed.bundle)}` : typed.file !== undefined ? ` --entry ${shellQuote(typed.file)}` : "";
  if (dest.kind === "workspace") {
    const branch = dest.branch !== undefined && dest.branch !== "" ? ` --branch ${shellQuote(dest.branch)}` : "";
    return (
      `\`xanosdk release create <name> --from workspace${branch}${against}${flags}\` stores what the workspace now runs as a ` +
      `release that ${landed} (${land}).`
    );
  }
  if (isEphemeral) {
    return (
      `\`xanosdk release create <name> --from ephemeral:${shellQuote(dest.name)}${against}${flags}\` stores what it now runs as a ` +
      `release that ${landed}.`
    );
  }
  const source =
    typed.bundle !== undefined ? ` --bundle ${shellQuote(typed.bundle)}` : typed.file !== undefined ? ` ${shellQuote(typed.file)}` : "";
  return (
    `A release is cut from a backend that ran on the instance, and a standard tenant cannot be cut from. To keep this ` +
    `source as one that ${landed}: \`xanosdk deploy${source} --ephemeral${flags}\` (to this project's ephemeral), then ` +
    `\`xanosdk release create <name>${against}${flags}\`, then ${land} lands it here — it REPLACES what the tenant runs ` +
    `with that release, so anything else merged onto it (another project's objects) is dropped.`
  );
}

/**
 * The refusal for `deploy --to tenant:<t>` (real or `--dry-run`) when the
 * tenant has no workspace yet: a tenant on its own domain gets one when its
 * first release lands, and a code merge needs one to merge into. The remedies
 * are the landings that create it — an existing release, or this run's source
 * cut as one through the project's ephemeral — and then this deploy.
 * Exported for tests.
 */
export function tenantWithoutWorkspace(
  tenant: string,
  named: string,
  typed: { file?: string; bundle?: string },
  args: ParsedArgs,
): CliError {
  const flags = contextFlags(args);
  const yes = pipedYes(args);
  const t = shellQuote(tenant);
  const source =
    typed.bundle !== undefined ? ` --bundle ${shellQuote(typed.bundle)}` : typed.file !== undefined ? ` ${shellQuote(typed.file)}` : "";
  const against =
    typed.bundle !== undefined ? ` --bundle ${shellQuote(typed.bundle)}` : typed.file !== undefined ? ` --entry ${shellQuote(typed.file)}` : "";
  const land = (release: string) => `\`xanosdk tenant deploy ${t} ${release}${yes}${flags}\``;
  // The cut carries the rows this run asked to seed; the rerun is this run as
  // typed — a dry run stays one, and a real run gets the `--yes` it needs here.
  const seed = args.seed ? " --seed" : "";
  const rerun = retryCommand(args, {
    add: args.dryRun || yes === "" ? [] : ["--yes"],
    command: `deploy --to ${shellQuote(`tenant:${tenant}`)}`,
  });
  return new CliError(
    "SDK_USAGE",
    `${named} has no workspace yet, so there is nothing for \`deploy --to\` to merge into or preview against — ` +
      `a tenant on its own domain gets its workspace when its first release lands. Nothing was written.\n` +
      `Land a release on it first: ${land("<release>")} (\`xanosdk release list${flags}\` names them). ` +
      `To land this source, deploy it to this project's ephemeral (\`xanosdk deploy${source} --ephemeral${flags}\`), cut it ` +
      `(\`xanosdk release create <name>${against}${seed}${flags}\`), and land that: ${land("<name>")}.\n` +
      `After that, \`${rerun.command}\` ${args.dryRun ? "previews merging" : "merges"} onto it.${withheldNote(rerun.withheld)}`,
    { details: { reason: "tenant-has-no-workspace", tenant } },
  );
}

/** Whether a landed bundle ships file-library entries — the bytes of its `hostedFile()` references. */
function shipsStoredFiles(bundle: unknown): boolean {
  const payload = (bundle as { payload?: { vault?: unknown } } | undefined)?.payload;
  return Array.isArray(payload?.vault) && payload.vault.length > 0;
}

/**
 * The one ephemeral `.xano/ephemeral.json` tracks, by name — what a bare
 * `--to ephemeral` stands for in its refusal's `--to tenant:<name>`. Read
 * before any credential, so with several tracked (one per profile) none is
 * picked.
 */
async function soleTrackedEphemeral(): Promise<string | undefined> {
  const { readEphemeralState } = await import("../deploy/ephemeral-state.js");
  const names = new Set(Object.values(readEphemeralState(process.cwd()).environments).map((r) => r.name));
  return names.size === 1 ? [...names][0] : undefined;
}

/**
 * Send this deploy somewhere real instead of to an ephemeral.
 *
 * The escape hatch from the release flow, and the only path that still merges
 * from a local build — which is why it keeps the whole pre-flight (plan
 * preview, prune scope, loss warnings, shared-schema gate, canonical pinning)
 * that `promote` structurally cannot run.
 *
 * A release source is refused here. Supporting it would make this strictly
 * better than the taught path — the same input, plus five checks — and invert
 * the positioning the grammar rests on. The escape hatch is for code that has
 * no release; it is not a second, better way to land one.
 */
async function runDeployToDestination(args: ParsedArgs, to: string): Promise<void> {
  const { requireBackendSlot, parseSlot } = await import("./backend-slot.js");
  const { resolveSource, describeBackend } = await import("./source-resolve.js");
  const { looksLikeSource, resolveProjectEntry } = await import("./deploy-source.js");

  // FIRST, before any other refusal and long before a credential: the slot's
  // declaration refuses `--to local[:name]` naming `--local`, and
  // `--to ephemeral` naming the bare deploy. Either one parsed any later would
  // be a destination this handoff had already started treating as hosted.
  const dest = parseSlot(requireBackendSlot("deploy", undefined, "to"), to, to.trim() === "ephemeral" ? await soleTrackedEphemeral() : undefined);
  if (dest.kind !== "workspace" && dest.kind !== "tenant") {
    throw new Error(`Internal: \`deploy --to\` parsed ${withArticle(dest.kind)}, which its slot does not accept.`);
  }

  if (args.file !== undefined && looksLikeSource(args.file)) {
    // Every source shape, not just `release:`. `--to` merges from a LOCAL
    // build; a source names something that already exists on a server. Narrowed
    // to `release:` before, the rest fell through to the compile path and
    // failed as a missing file, which describes neither the input nor the fix.
    const flags = contextFlags(args);
    const release = /^release:(.*)$/.exec(args.file)?.[1];
    const releaseWord = release === undefined || release === "" ? "<name>" : shellQuote(release);
    // Both landings ask before they write: the `--yes` this run carried (or an
    // off-terminal run's) carries over, so the landing runs as printed. Never
    // for a `--dry-run`: neither verb takes one, and without `--yes` each shows
    // what it would land and stops at its question.
    const { pipedYes } = await import("./retry-command.js");
    const yes = args.dryRun === true ? "" : pipedYes(args);
    // For `--to tenant:<t>` the tenant is known and the tenant landing is the
    // one asked for, so it comes first and filled (E2E pass 26).
    const tenantLanding = `\`xanosdk tenant deploy ${dest.kind === "tenant" ? shellQuote(dest.name) : "<tenant>"} ${releaseWord}${yes}${flags}\``;
    // The landing flags promote shares with this run, so its landing is the one asked for.
    const landing = `${args.branch === undefined ? "" : ` --branch ${shellQuote(args.branch)}`}${args.setLive === true ? " --set-live" : ""}`;
    const promote = `\`xanosdk promote ${releaseWord}${landing}${yes}${flags}\``;
    const advice = /^release:/.test(args.file)
      ? `A release already has a home on the server, so landing it is ` +
        (dest.kind === "tenant"
          ? `${tenantLanding} (or ${promote} for your workspace)`
          : `${promote} (or ${tenantLanding})`) +
        ` — not a deploy. \`--to\` is for code that has no release yet.` +
        (args.dryRun === true ? ` Neither takes \`--dry-run\`: without \`--yes\`, each shows what it would land and asks first.` : ``)
      : `\`--to\` merges a build compiled HERE, and "${args.file}" already exists on a server. ` +
        `Pull it into this project first (\`xanosdk pull ${shellQuote(args.file)}${flags}\`) and deploy that, or cut ` +
        `a release from it and promote that.`;
    throw new UsageError(advice, { hintFor: { command: "deploy" } });
  }
  // Here rather than in the release it hands off to, which loads the bundle
  // after resolving a credential.
  refuseValueFlagsBesideBundle(args, { command: "deploy" });

  // A bare `xanosdk deploy --to workspace` inside a project means its entry, the
  // same shorthand the ephemeral path takes. Without this, the destination that
  // reaches production was the one that still demanded the path spelled out.
  // What the reader typed as the source, before the shorthand fills it in: the
  // store-as-release hint repeats it, and a resolved absolute path is noise.
  const typed = { file: args.file, bundle: args.bundle };
  if (args.file === undefined && args.bundle === undefined) {
    const entry = resolveProjectEntry(process.cwd());
    if (entry !== undefined) args = { ...args, file: entry };
  }
  // Before the credential the resolve below reads.
  assertBundleFile(args, { command: "deploy" });
  assertEntryFile(args);
  assertValueFiles(args, { command: "deploy" });
  refuseMissingLockDir(args);
  refuseMissingStaticDir(args);

  const resolved = await resolveSource(dest, async () => {
    const auth = await getAccessToken(args);
    await noteRunScopeFor(auth);
    return auth;
  }, { workspaceless: "any" }); // A tenant with no workspace is refused below, with this run's own remedies.

  // An ephemeral IS a tenant on the wire, so `--to tenant:<name>` can name one.
  // Its record says which, and an absent type fails closed to "not an ephemeral".
  const isEphemeral = dest.kind === "tenant" && resolved.target.tenantType === "ephemeral";
  const noun = isEphemeral ? "ephemeral" : "tenant";

  // The branch machinery belongs to a workspace. A tenant has no branches to
  // name, so a flag that scopes one would silently do nothing.
  if (dest.kind === "tenant") {
    const branchy = [
      args.branch !== undefined ? "--branch" : undefined,
      args.setLive ? "--set-live" : undefined,
      args.backupBranch !== undefined ? "--backup-branch" : undefined,
    ].filter((f): f is string => f !== undefined);
    if (branchy.length > 0) {
      throw new UsageError(
        `${andList(branchy)} ${branchy.length === 1 ? "scopes" : "scope"} a branch, and ${isEphemeral ? "an ephemeral" : "a tenant"} has none. ` +
          `\`--to workspace\` is the destination that has them.`,
        { hintFor: { command: "deploy" } },
      );
    }
  }

  // `ephemeral "x" ("Display")` or `tenant "x"`: the display name rides beside the handle.
  const named = describeBackend(resolved);
  // A tenant on its own domain has no workspace until its first release lands,
  // and this merges into that workspace: refused before the compile, with the
  // landing that creates it, rather than as the preview's 404.
  if (dest.kind === "tenant" && !isEphemeral && resolved.backend.kind === "hosted") {
    const { tenantHasWorkspace } = await import("../deploy/tenant.js");
    if (!(await tenantHasWorkspace(resolved.backend.auth, resolved.target.base))) {
      throw tenantWithoutWorkspace(dest.name, named, typed, args);
    }
  }
  // A dry run writes nothing, so there is nothing to warn about: the plan's own
  // step line and its closing "nothing was written" line say what it did.
  if (!args.dryRun) {
    warn(`Writing to ${named}${isEphemeral ? "" : " — this is not an ephemeral"}.`, isEphemeral ? "deploy.ephemeral-write" : "deploy.tenant-write");
  }
  // What this run keeps is its LANDING RECORD (the scope of a later `--prune`),
  // not a release: saying it "leaves no record" contradicted the record it
  // writes. Said once it HAS landed — before, it read as the outcome of a run
  // that could still be refused (a prune out of scope, a taken identity).
  const afterLanding = (landedBundle: unknown): void => {
    // Under `--no-lock` nothing records a tenant or workspace landing — only an
    // ephemeral's record, which lives in `.xano/ephemeral.json`, is kept.
    const recorded = isEphemeral || !args.noLock;
    // A `--backup-branch` run has just printed its rollback: what is missing is
    // a release, not a way back.
    const nothing =
      args.backupBranch !== undefined && args.backupBranch !== false && dest.kind === "workspace"
        ? "no release to list, export, or land again — the backup branch above is what rolls its logic back"
        : "nothing to list, export, or roll back to";
    detail(
      recorded
        ? `No release is stored: this run records only what it landed (in ${isEphemeral ? ".xano/ephemeral.json" : "xano.lock"}, ` +
            `for \`--prune\`), so there is ${nothing}.`
        : `No release is stored, and under \`--no-lock\` nothing records what this run landed, so there is ${nothing}, ` +
            "and a later `--prune` has no record to scope it.",
    );
    detail(
      storeAsReleaseHint(
        dest.kind === "workspace" ? { kind: "workspace", ...(args.branch !== undefined ? { branch: args.branch } : {}) } : dest,
        isEphemeral,
        typed,
        contextFlags(args),
        args.yes,
        shipsStoredFiles(landedBundle),
      ),
    );
  };

  const { runReleaseCommand } = await import("./release-command.js");
  return runReleaseCommand(args, {
    base: resolved.target.base,
    workspaceId: resolved.target.workspaceId,
    // Carried so the release knows whether this destination HAS branches: the
    // `--replace` branch-deletion guard is a workspace-only question.
    kind: dest.kind,
    // Only a tenant carries a label into the step line. For `--to workspace` the
    // resolved label is "your workspace", which the disclosure would render as
    // "your workspace — host · workspace 42": the same word twice, and no new fact.
    ...(dest.kind === "tenant" ? { label: named } : {}),
    // The machine destination's `kind` and bare `label`: the target's ACTUAL type.
    ...(dest.kind === "tenant" ? { type: noun, name: resolved.target.label } : {}),
    // What people call it, for the headline and the machine destination.
    ...(dest.kind === "tenant" && resolved.target.display !== undefined && resolved.target.display !== ""
      ? { display: resolved.target.display }
      : {}),
    // The credential resolved above, so it is resolved (and its profile notice printed) once.
  }, {
    ...(resolved.backend.kind === "hosted" ? { auth: resolved.backend.auth } : {}),
    afterLanding,
    // A merge whose outcome is unknown is previewed again with this run's own command.
    stateCheck: toStateCheck(args, named),
  });
}

/**
 * Flags that only mean something once a destination is named.
 *
 * `deploy` advertises them because `--to` uses them. Without `--to` a deploy
 * refreshes its own environment — replacing it, or with `--keep-data` merging
 * into it — and none of these scopes either: there is no preview to stop at,
 * no branch, and the seed/prune choices are already made by the arm. Refused
 * rather than ignored, for the reason `--dry-run` makes loudest: a run that
 * promises a preview and instead performs the deploy is the one silent no-op
 * nobody recovers from.
 */
export const DESTINATION_ONLY: ReadonlyArray<{ readonly key: keyof ParsedArgs; readonly flag: string; readonly why: string }> = [
  { key: "dryRun", flag: "--dry-run", why: "a refresh has no plan to preview — it replaces the environment, or merges into it with `--keep-data`" },
  { key: "prune", flag: "--prune", why: "a refresh leaves nothing behind to prune — a replace rewrites the whole environment" },
  { key: "replace", flag: "--replace", why: "a refresh already replaces unless `--keep-data` says to merge" },
  { key: "resetData", flag: "--reset-data", why: "a refresh already replaces the rows unless `--keep-data` keeps them (`--reset` overrides that)" },
  { key: "seed", flag: "--seed", why: "a refresh already seeds when it replaces and never when `--keep-data` keeps the rows" },
  { key: "allowSharedSchemaChanges", flag: "--allow-shared-schema-changes", why: "the environment is this project's own, with no shared schema to gate" },
  { key: "allowBranchDeletion", flag: "--allow-branch-deletion", why: "an ephemeral or Xano Engine has no branches to delete" },
  { key: "branch", flag: "--branch", why: "an ephemeral or Xano Engine has no branch to name" },
  { key: "setLive", flag: "--set-live", why: "an ephemeral or Xano Engine has no branch to make live" },
  { key: "backupBranch", flag: "--backup-branch", why: "an ephemeral or Xano Engine has no branch to back up" },
];

function assertNoDestinationFlags(args: ParsedArgs): void {
  const passed = DESTINATION_ONLY.filter((f) => args[f.key] !== undefined && args[f.key] !== false);
  if (passed.length === 0) return;
  const names = passed.map((f) => f.flag);
  const one = names.length === 1;
  // Each flag's own reason: one sentence for all of them ("nothing for it to
  // scope") was `--prune`'s, and read as nonsense beside `--seed` or `--dry-run`.
  const why = passed.map((f) => (one ? f.why : `\`${f.flag}\`: ${f.why}`)).join("; ");
  throw new UsageError(
    `${andList(names)} ${one ? "needs" : "need"} a destination, and this deploy names none — ` +
      `it refreshes this project's own ephemeral or Xano Engine, and ${why}. Add \`--to workspace\` ` +
      `(or \`--to tenant:<name>\`) to reach a real destination, or drop ${one ? "the flag" : "the flags"}.` +
      (args.keepData ? ` \`--keep-data\` still keeps this environment's rows without them.` : "") +
      (args.dryRun ? ` ${previewOwnEphemeral(args)}` : ""),
    { hintFor: { command: "deploy" } },
  );
}

/**
 * The preview `--dry-run` was asked for: this project's ephemeral, named as a
 * tenant destination, previews the merge a `--to` deploy makes there. Named
 * when the project tracks exactly one; otherwise `ephemeral list` names it.
 */
function previewOwnEphemeral(args: ParsedArgs): string {
  let names: string[] = [];
  try {
    names = [...new Set(Object.values(readEphemeralState(process.cwd()).environments).map((r) => r.name))];
  } catch {
    // An unreadable state file names nothing: the placeholder stands.
  }
  const target = names.length === 1 ? `tenant:${names[0]}` : "tenant:<ephemeral>";
  const entry = args.file === undefined ? "" : ` ${shellQuote(pastePath(args.file))}`;
  return (
    `To preview a merge into this project's ephemeral, run \`xanosdk deploy${entry} --to ${target} --dry-run${contextFlags(args)}\`` +
    (names.length === 1 ? "." : " (`xanosdk ephemeral list` names it).")
  );
}

/**
 * Flags that describe the ephemeral (or Xano Engine) a deploy with no `--to`
 * refreshes — the mirror of {@link DESTINATION_ONLY}.
 *
 * `--to` hands the run to the release merge, which reads none of them: it
 * creates no environment to name or give a lifetime, runs no suite, waits on
 * no microservice, points no dev env, and opens nothing. Each was accepted
 * there and dropped, so `--to … --test` exited 0 with no `testRun` — the
 * quietly-ignored flag this CLI refuses to have.
 */
export const EPHEMERAL_ONLY: ReadonlyArray<{ readonly flag: string; readonly passed: (args: ParsedArgs) => boolean }> = [
  { flag: "--name", passed: (a) => a.name !== undefined },
  { flag: "--expires-hours", passed: (a) => a.expiresHours !== undefined },
  { flag: "--reset", passed: (a) => a.reset },
  { flag: "--test", passed: (a) => a.test },
  { flag: "--kind", passed: (a) => a.kind !== undefined },
  { flag: "--concurrency", passed: (a) => a.concurrency !== undefined },
  { flag: "--no-dev-env", passed: (a) => a.noDevEnv },
  { flag: "--require-microservices", passed: (a) => a.requireMicroservices },
  { flag: "--open", passed: (a) => a.open },
];

/** The {@link EPHEMERAL_ONLY} flags that run (or shape) the post-deploy suite. */
const TEST_FLAGS: ReadonlySet<string> = new Set(["--test", "--kind", "--concurrency"]);

/**
 * Refuse every flag `--to` would drop, before anything is signed into.
 *
 * `--static` is the one that does carry: `--to` publishes the frontend beside
 * its merge — but not under `--dry-run`, which writes nothing, so there it is
 * refused too. `--skip-liveness` only skips that publish's rollout check under
 * `--to`, so it needs `--static` there.
 */
export function assertNoEphemeralFlags(args: ParsedArgs): void {
  if (args.to === undefined) return;
  const names = EPHEMERAL_ONLY.filter((f) => f.passed(args)).map((f) => f.flag);
  if (names.length > 0) {
    const one = names.length === 1;
    // The test flags are said as what they DO — "describes the ephemeral" read
    // wrong for `--test` — and the suite `--to`'s backend CAN have is named.
    const testing = names.filter((n) => TEST_FLAGS.has(n));
    const describing = names.filter((n) => !TEST_FLAGS.has(n));
    const what = [
      ...(describing.length > 0
        ? [`${andList(describing)} ${describing.length === 1 ? "describes" : "describe"} the ephemeral a deploy with no \`--to\` refreshes`]
        : []),
      ...(testing.length > 0
        ? [
            testing.includes("--test")
              ? `${andList(testing)} ${testing.length === 1 ? "runs" : "run"} the ephemeral's tests after a deploy with no \`--to\``
              : `${andList(testing)} ${testing.length === 1 ? "shapes" : "shape"} the test run \`--test\` makes on the ephemeral ` +
                `after a deploy with no \`--to\``,
          ]
        : []),
    ].join(", and ");
    const kind = args.kind !== undefined ? ` --kind ${args.kind}` : "";
    const concurrency = args.concurrency !== undefined ? ` --concurrency ${args.concurrency}` : "";
    const testThere =
      testing.length > 0
        ? ` To test ${args.to === "workspace" ? "the workspace" : args.to}, run \`xanosdk test run-all --on ${shellQuote(args.to)}${kind}${concurrency}${contextFlags(args)}\` once the deploy has landed.`
        : "";
    throw new UsageError(
      `${what}; \`--to\` ` +
        // Worded for both arms: `--to` merges by default and replaces under
        // `--replace`, and either way it writes to a backend that already exists.
        `${args.replace ? "replaces" : "merges into"} a backend that already exists — so ` +
        `${one ? "it is" : "they are"} refused rather than quietly skipped. Nothing was deployed. ` +
        `Drop ${one ? "it" : "them"}, or drop \`--to\` to deploy to this project's ephemeral.${testThere}`,
      { hintFor: { command: "deploy" } },
    );
  }
  if (args.static !== undefined && args.dryRun) {
    throw new UsageError(
      "`--static` publishes a frontend, and `--dry-run` writes nothing — so the preview would " +
        `say nothing about it. Drop \`--static\` to preview the ${args.replace ? "replace" : "merge"}, or \`--dry-run\` to publish.`,
      { hintFor: { command: "deploy" } },
    );
  }
  if (args.skipLiveness && args.static === undefined) {
    throw new UsageError(
      "`--skip-liveness` skips `--static`'s rollout check under `--to`, and this deploy publishes " +
        "no frontend — so it would change nothing. Drop it, or add `--static <dir>`.",
      { hintFor: { command: "deploy" } },
    );
  }
}

/**
 * Where this deploy is going, decided ONCE at the top of the command.
 *
 * A value rather than an `if` at the destination call, because the command asks
 * "where is this going" at four separate points — whether to resolve a
 * credential, which archive transport to use, where the post-deploy tests run,
 * and whether a static site can be published — and a branch at the last of them
 * leaves the other three on the hosted assumption. It is also the shape that
 * survives a third destination.
 */
export type DeployDestination =
  | { readonly kind: "ephemeral" }
  | {
      readonly kind: "local";
      /**
       * The override the flag carried — a URL or an archive path. Absent means
       * a published release; see `resolveEngineSource` for the precedence.
       */
      readonly downloadUrl: string | undefined;
    };

/** Read the destination off the parsed flags. No I/O, no refusals — see {@link assertLocalEngineUsable}. */
export function resolveDeployDestination(args: ParsedArgs): DeployDestination {
  return args.localEngine
    ? { kind: "local", downloadUrl: args.localEngineUrl }
    : { kind: "ephemeral" };
}

/**
 * Everything `--local` refuses, all of it BEFORE any work.
 *
 * Two flag combinations and one fact about the machine. Every one of them
 * fails a run that has compiled nothing, resolved no credential and written
 * nothing, which is what lets them be ordinary errors rather than new exit
 * codes: the allocated codes all mean "the deploy happened and something after
 * it did not".
 *
 * The `--to` refusal in particular has to run before the `--to` handoff below
 * it. Under it, `--local --to workspace` reads as an ordinary hosted
 * deploy and lands in a real workspace with nothing said.
 *
 * There is no "nowhere to get an engine" refusal: on a supported machine a bare
 * flag resolves a published release, so every run has a source.
 */
async function assertLocalEngineUsable(args: ParsedArgs, dest: DeployDestination): Promise<void> {
  if (dest.kind !== "local") return;

  if (args.to !== undefined) {
    throw new UsageError(
      "`--local` and `--to` are two destinations, and a deploy has one. " +
        "Drop whichever is not meant: `--local` runs this workspace on an engine on " +
        "this machine, `--to` merges it into a backend that already exists. Either one alone " +
        "still works exactly as it did.",
      { hintFor: { command: "deploy" } },
    );
  }

  // Both describe an ephemeral (its display name, its lifetime); a Xano Engine
  // has neither, so they are refused rather than silently dropped.
  const ephemeralOnly = [
    ...(args.name !== undefined ? ["--name"] : []),
    ...(args.expiresHours !== undefined ? ["--expires-hours"] : []),
  ];
  if (ephemeralOnly.length > 0) {
    const one = ephemeralOnly.length === 1;
    throw new UsageError(
      `${andList(ephemeralOnly)} ${one ? "describes" : "describe"} an ephemeral, and a Xano Engine ` +
        `has no display name or expiry, so ${one ? "it is" : "they are"} refused rather than quietly ` +
        `skipped. Drop ${one ? "it" : "them"}, or add \`--ephemeral\` to deploy to an ephemeral.`,
      { hintFor: { command: "deploy" } },
    );
  }

  // Lazily imported, like everything Node-only this command reaches: the
  // browser-safe authoring bundle must not pull the local stack in.
  const { engineSourceRefusal, MISSING_ARCHIVE, resolveEnginePlatform, SUPPORTED_PLATFORMS } = await import(
    "../deploy/local-engine-config.js"
  );

  // An engine source this run could not use — plain http off this machine, a
  // version that is not one — refused before any request goes out. A path that
  // names no file is a usage error (exit 1), as every named local file that is not there is
  // (E2E pass 29).
  const sourceRefusal = engineSourceRefusal(dest.downloadUrl);
  if (sourceRefusal !== undefined) {
    const Refusal = sourceRefusal.startsWith(MISSING_ARCHIVE) ? LocalFileNotFoundError : UsageError;
    throw new Refusal(sourceRefusal, { hintFor: { command: "deploy" } });
  }

  if (resolveEnginePlatform() === undefined) {
    throw new Error(
      `There is no Xano Engine build for ${process.platform} ${process.arch} — it runs on ` +
        `${SUPPORTED_PLATFORMS.join(", ")} and nothing else, so there is no engine to run here. ` +
        `Deploy from one of those machines, or add \`--ephemeral\`: \`xanosdk deploy --ephemeral\` ` +
        `reaches an ephemeral from anywhere.`,
    );
  }
}

/**
 * Send this deploy to an engine on this machine.
 *
 * Reached only once every refusal above has passed, so what is left is the
 * destination itself: compile, acquire and start (or reuse) the engine, record
 * it, import into it, and report.
 *
 * ## `--static`
 *
 * Published to the engine's own static host (`default` unless `--static-host`
 * names another), after the import, as on an ephemeral: the engine serves it at
 * `http://<prefix>.localhost:<port>`. A build with a server half (`.xano-ssr/`,
 * written by `@xano/sdk/sveltekit`) uploads it too, and the engine renders the
 * site's dynamic routes with it. The rollout is not polled: the engine serves a
 * build the moment its upload returns, and Node may not resolve `*.localhost`.
 *
 * ## What this arm deliberately does not do
 *
 * No microservice wait: that read is
 * a property of a hosted environment's rollout, and the engine is the process
 * this command just started. No toolchain hooks either, while this destination
 * is a prototype behind a flag; the hosted deploy still runs them, and a
 * derived-artifact tree describes the SOURCE rather than where it landed.
 *
 * ## The engine's bearer
 *
 * Handed to the import (and to `--test`) as a two-field {@link BearerTarget},
 * which is the whole of what those transports read. It is never widened into a
 * credential, never recorded, and never printed.
 */
async function deployToLocalEngine(
  args: ParsedArgs,
  dest: Extract<DeployDestination, { kind: "local" }>,
  /**
   * Present only for a FETCHED source — see the call site. A provider, not a
   * credential: the resolver calls it for a hosted source and never for a
   * Xano Engine, so copying one engine into another signs in nowhere.
   */
  sourceCredential: CredentialProvider | undefined,
  ctx: { startedAt: number },
): Promise<void> {
  const { startedAt } = ctx;
  const dir = process.cwd();
  // Carried as a value: a fetched source has both a spec and the provider its
  // credential (if any) comes from, and a compiled one has neither. Pairing
  // them here is what keeps the two facts from drifting apart into a non-null
  // assertion.
  const fetchedSource =
    sourceCredential !== undefined && args.file !== undefined
      ? { credential: sourceCredential, spec: args.file }
      : undefined;

  // Toolchain plugins import BEFORE the compile below, for the same reason the
  // hosted arm discovers them first: loading the user's entry unregisters the
  // TypeScript loader behind it, and a later dynamic import would trip over
  // that in a source checkout.
  const { discoverToolchainPlugins } = await import("./toolchain-modules.js");
  const toolchain = await discoverToolchainPlugins(dir, { frozen: args.frozenLock === true });

  // The archive first, so a project that does not build never stands an engine
  // up — and so the step line below can name what is being deployed.
  const { archive, shownSource, bundleObject, bundleText, content, passwordColumns, classifiedLock, commitLock, nonPublicSeedValues } = fetchedSource
    ? await import("./deploy-source.js")
        .then(async (m) => {
          const f = await m.fetchSourceArchive(fetchedSource.credential, fetchedSource.spec, dir);
          // Decoded back out of the bytes about to be uploaded, for the same
          // reason the hosted arm does it: it proves they are well-formed
          // before an engine is started for them.
          const decoded = decodeWorkspaceArchive(f.archive);
          noteReleaseCarriesNoEnv(fetchedSource.spec, m.gatedApiGroups(decoded));
          return {
            archive: f.archive,
            source: f.provenance,
            // The headline's name for it: the handle, and beside it what people call it.
            shownSource: shownSourceOf(f),
            bundleObject: decoded,
            // Only a merge reads the text, so it is serialized there, on demand.
            bundleText: undefined as string | undefined,
            // The seed rows a release carries, read only to name what a merge leaves unwritten.
            content: m.archiveSeedContent(f.archive),
            passwordColumns: m.passwordSeedColumns(f.archive),
            classifiedLock: undefined as LockFile | undefined,
            commitLock: undefined as (() => void) | undefined,
            // A fetched backend carries no seed values to look for in a frontend.
            nonPublicSeedValues: [] as NonPublicSeedValue[],
          };
        })
    : // The lock write waits for the import to land (a rename the lock was
      // not told about, an engine that cannot apply the merge, …): a refused or
      // failed deploy leaves `xano.lock` as it found it (E2E passes 26, 28).
      await loadBundleText(args, { command: "deploy" }, { withSeed: true, deferLockWrite: true }).then((l) => ({
        archive: encodeWorkspaceArchive(l.bundle, [...l.content, ...l.files]),
        source: l.source,
        shownSource: shownInput(l.source),
        bundleObject: l.bundleObject ?? (JSON.parse(l.bundle) as Bundle),
        bundleText: l.bundle,
        content: l.content,
        passwordColumns: [] as string[],
        classifiedLock: l.classifiedLock,
        commitLock: l.commitLock,
        nonPublicSeedValues: l.nonPublicSeedValues,
      }));
  if (fetchedSource === undefined) await ignoreBackendSecretFilesRead(args);

  // The `--static` directory and its seed scan, before an engine is stood up and
  // before the import: found only at publish time, a bad directory would have
  // cost the engine its rows first. The server half counts as an entry page here,
  // since the engine renders it.
  if (args.static !== undefined) {
    await assertNoSeedLeaks(args.static, nonPublicSeedValues, { serverRendered: true });
  }

  step(`Deploying ${shownSource} → Xano Engine`);

  // The derived-artifact hooks, after the compile and BEFORE an engine is stood
  // up. A hook describes the SOURCE, so it has the same job here as on the
  // hosted arm — and a check that did not pass must not be one a local deploy
  // quietly skips. Running it before the start means a failing check leaves no
  // engine behind to reclaim.
  {
    const { runBundleHooks } = await import("./toolchain-hooks.js");
    // Lazily, because this module only type-imports from `cli.js` — a value
    // import between the two would close a cycle.
    const { readVersion } = await import("./cli.js");
    await runBundleHooks(
      toolchain.loaded,
      {
        bundle: bundleObject as Bundle,
        // Absent on the fetched-source branch, which is the documented signal
        // for "the project did not compile this" — it lets a plugin decline
        // rather than render a remote backend over this repo's own tree.
        entry: fetchedSource ? undefined : args.file,
        cwd: dir,
        command: "deploy",
        frozen: args.frozenLock === true,
        sdkVersion: readVersion(),
      },
      "; nothing was deployed",
    );
  }

  // Which engine this run uses — an override on the flag, the project's pin
  // (after offering any newer release), or the latest release — decided here,
  // after the compile and before anything is downloaded, so a prompt never
  // waits in front of a project that does not build.
  const { chooseLocalEngine, explainOverrideFailure, pinAfterAcquire } = await import("./local-engine-choice.js");
  const choice = await chooseLocalEngine(dest.downloadUrl, dir, isMachineOutput(args));

  // Lazily, like everything Node-only this command reaches. Returns only once
  // the engine is serving AND recorded — the import below cannot run
  // before the record exists, because this call has not returned.
  const { ensureProjectEngine } = await import("../deploy/local-engine-deploy.js");
  const pin = pinAfterAcquire(choice, dir);
  // The completed-import marker survives the engine's record write whenever it
  // vouches for the engine serving now, whichever arm runs: the import is one
  // transaction, so a failed one leaves the rows it vouched for standing, and a
  // replace that completes re-stamps it below.
  const flags = { keepData: args.keepData, reset: args.reset };
  const { engine, reused, previousUrl, hadRecord, priorFilled, engineVersion, replaced, sweptOrphans } =
    await withSpinner("Preparing the Xano Engine…", () =>
      ensureProjectEngine({
        dir,
        source: choice.source,
        rerun: rerunOf(args).command,
        rerunNote: rerunOf(args).note,
        onAcquired: pin.onAcquired,
        carryFilled: (ctx) => ctx.reused && ctx.priorFilled !== undefined && ctx.priorFilled.url === ctx.url,
      }).catch((err: unknown) => explainOverrideFailure(choice, err)),
    );
  pin.announce();
  if (sweptOrphans !== undefined) {
    info(
      `Stopped ${sweptOrphans.length === 1 ? "a process" : `${sweptOrphans.length} processes`} a crashed Xano Engine ` +
        `left running (pid ${sweptOrphans.join(", ")}).`,
    );
  }
  if (replaced !== undefined) {
    info(
      `Replaced Xano Engine ${replaced.name} (${replaced.from ?? "an unrecorded version"} → ` +
        `${replaced.to ?? "the resolved engine"}). It starts empty, so this deploy seeds it.`,
    );
  }
  const arm = selectDeployArm({
    ...flags,
    created: !reused,
    hadRecord,
    priorFilled,
    url: engine.url,
  });
  await refuseEnvClearedByFallbackReplace(arm);

  const target: LocalEngineTarget = {
    kind: "local",
    url: engine.url,
    workspaceId: engine.workspaceId,
  };
  // Before the work, through the shared helper, and saying in words that
  // this is not a hosted instance.
  discloseWriteTarget(target);
  announceArm(arm, "local");

  const bearer = { access_token: engine.token, instance: engine.url };
  let merged: KeepDataMergeResult | undefined;
  // Whether the import itself was sent. Before it — a keep-data refusal, a
  // preview that failed — nothing was imported, so the failure is said alone
  // and `.xano/deployed.json` keeps what it held (E2E pass 27: a refused
  // preview printed "The import failed" and rewrote `deployedAt`).
  let sent = false;
  const sending = (): void => {
    sent = true;
    // A reused engine is recorded here; a started one already was.
    if (reused) recordDeployed(dir, "local");
  };
  try {
    if (arm.arm === "merge") {
      const { mergeKeepingData } = await import("./keep-data-merge.js");
      merged = await mergeKeepingData({
        auth: bearer,
        baseUrl: engine.url,
        workspaceId: engine.workspaceId,
        label: `Xano Engine ${engine.name}`,
        bundle: bundleText ?? JSON.stringify(bundleObject),
        content,
        files: archiveHostedFiles(archive),
        // No credential flags: a Xano Engine refuses them.
        stateCheck:
          `Check what Xano Engine ${engine.name} now holds with \`xanosdk tables local:${shellQuote(engine.name)}\` ` +
          `before retrying.`,
        envSetTo: ` --to ${shellQuote(`local:${engine.name}`)}`,
        kind: "local",
        rerun: rerunOf(args),
        // The lock waits for the import itself, not only its refusals: an
        // engine that cannot apply this merge (a 501) wrote nothing, and a lock
        // rewritten for it would be a diff to commit for a deploy that never
        // landed (E2E pass 28). The identities it would record derive from
        // names, so a lost write re-derives the same ones next run.
        beforeWrite: sending,
        ...(await mergeGuards(args, classifiedLock, {
          bundle: bundleText ?? JSON.stringify(bundleObject),
          compiled: fetchedSource === undefined && args.bundle === undefined,
        })),
      });
    } else {
      sending();
      // Same `preserveGuids` contract as the ephemeral import, and for the same
      // reason: the archive's identities are derived and frozen in `xano.lock`,
      // so preserving them makes a redeploy UPDATE what the last one created.
      await withSpinner(IMPORTING_LABEL, () =>
        xanosdkImport(bearer, {
          baseUrl: engine.url,
          workspaceId: engine.workspaceId,
          archive,
          mode: "replace",
          dryRun: false,
          preserveGuids: true,
          label: `Xano Engine ${engine.name}`,
        }),
      );
    }
  } catch (err) {
    // The engine is a process this command started and did not stop, so the
    // aftermath is different from the hosted one: nothing was torn down, and
    // there is no frontend to bring back. Say what is still true, then let the
    // engine's own error be the explanation. Only for an import that was sent:
    // a refusal before it already says nothing was written.
    if (err instanceof XanoSdkImportRefusal && err.retryable) {
      const { importInProgressError } = await import("./keep-data-merge.js");
      throw importInProgressError(`Xano Engine ${engine.name}`, rerunOf(args), err);
    }
    // An engine too old for this import answers with its own internals; say
    // that in the SDK's words instead.
    const { explainUnsupportedEngineImport } = await import("../deploy/local-engine-deploy.js");
    const unsupported = explainUnsupportedEngineImport(err, engineVersion, {
      latest: await latestEngineRelease(err),
      resetRerun: arm.arm === "merge" ? `${rerunOf(args).command} --reset` : undefined,
    });
    if (sent) {
      // A 501 is the engine saying it cannot do this import at all: nothing in
      // the project to fix, and the same deploy fails the same way (E2E pass
      // 29). The error below names the way on.
      const rerun = rerunOf(args);
      warn(
        "The import failed — the engine is still running, so nothing needs restarting:",
        "local.import-failed",
        [
          unsupported !== undefined
            ? `It is serving at ${engine.url}, holding what it held — this engine cannot run this import; the error below names what can.`
            : `It is serving at ${engine.url}. Fix what the error below names, then run \`${rerun.command}\` again.${rerun.note}`,
          `Stop it with \`xanosdk local stop ${engine.name}\`.`,
        ],
      );
    }
    throw unsupported ?? err;
  }
  // The lock, once the import landed — outside the try, so a lock that cannot
  // be written is not reported as a failed import.
  commitLock?.();
  // Only now: the marker vouches for rows that landed, so it is written after
  // the import that put them there and never before.
  const { markEngineFilled } = await import("../deploy/local-engine-state.js");
  markEngineFilled(dir, engine.url);

  // Same create-versus-refresh reading the ephemeral arm gives: a URL that
  // changed is the one thing a bookmark, a README or a running dev server has
  // to be told about.
  const urlChanged = !reused || previousUrl !== engine.url;
  if (urlChanged) {
    success(`Xano Engine ${engine.name} deployed${elapsedSuffix(startedAt)}`);
    info("New Xano Engine URL:");
    link(engine.url);
  } else {
    const kept = arm.arm === "merge" ? ", keeping its data" : "";
    success(`Redeployed to ${engine.name}${kept}${urlsNote(merged)}${elapsedSuffix(startedAt)}`);
    link(engine.url);
  }
  // The sign-in URL carries a per-process sign-in key, NOT the bearer, so it is
  // the one thing that answers "how do I open the builder" without printing the
  // bearer. It stays out of the machine document and out of every log line.
  detail(`Open the builder: ${engine.signInUrl}`);
  // Pointed at rather than printed: this output lands in terminals and CI logs,
  // and the bearer is only for the caller who asks for it.
  detail(`Meta API bearer (the local XANO_META_TOKEN): \`xanosdk local token\``);
  detail(`Stop it with \`xanosdk local stop ${engine.name}\``);
  // After the import, as on an ephemeral: the static host lives in the very
  // workspace the import replaces. Never fails the backend deploy.
  let staticSummary: StaticPublishSummary | undefined;
  if (args.static !== undefined) {
    staticSummary = await publishStaticToLocalEngine(args, args.static, engine, engineVersion);
  } else {
    // A reader must not be left assuming the frontend came along.
    detail(
      "No static site was published. Run your frontend locally against the URL above, or pass " +
        "`--static <dir>` to have the engine serve a built one.",
    );
  }

  const summary: DeploySummary = {
    kind: "local",
    destination: { ...writeTargetPayload(target), label: engine.name, url: engine.url },
    // Nothing chose a credential for this run, so there is no profile to name.
    // Null rather than omitted: the field is non-optional, and a wrapper that
    // reads it everywhere must not have to branch on the destination first.
    profile: null,
    url: engine.url,
    engine: {
      name: engine.name,
      workspaceId: engine.workspaceId,
      logPath: engine.logPath,
      ...(engineVersion === undefined ? {} : { engineVersion }),
      pin: pin.outcome(),
      ...(choice.override === undefined ? {} : { override: choice.override }),
    },
    created: !reused,
    ...dataFields(arm),
    ...mergeLossFields(merged),
    ...(staticSummary === undefined ? {} : { static: staticSummary }),
  };
  // A Xano Engine is never what a release was cut from, so seeded password
  // hashes from one never verify here — said once the rows are written.
  if (fetchedSource !== undefined && summary.data === "replaced") {
    const unverifiable = await notePasswordHashesDoNotTravel(
      fetchedSource.credential,
      fetchedSource.spec,
      passwordColumns,
      undefined,
    );
    if (unverifiable !== undefined) summary.passwordHashesUnverifiable = unverifiable;
  }
  // Carried into the document for the same reason the hosted arm carries it: a
  // CI job reading stdout never sees discovery's warning on stderr.
  noteUnconfigured(summary, toolchain.unconfigured);

  // Through the shared sync: the dev env is pointed at the engine exactly as it
  // would be pointed at an ephemeral (skipped when a frontend was published).
  await syncDevEnvAfterDeploy(args, summary, dir);

  // The engine's own bearer and its own workspace — never the hosted
  // credential a fetched source may have resolved, nor another engine's bearer
  // a local source was exported through.
  if (args.test) summary.testRun = await runDeployedTests(bearer, summary, args);

  if (args.open) openDeployed(summary);
  if (isMachineOutput(args)) writeJson(summary);
}

/**
 * `--static` on a Xano Engine: publish the built frontend to the engine's own
 * static host. The ephemeral arm's guard, in the local arm's words: a failure is
 * reported (and exits 3, or 9 when the upload's answer was lost), never thrown,
 * because the backend it follows has landed.
 */
async function publishStaticToLocalEngine(
  args: ParsedArgs,
  dir: string,
  engine: { name: string; url: string; workspaceId: number; token: string },
  engineVersion: string | undefined,
): Promise<StaticPublishSummary> {
  // The engine is re-deployed with the same command to retry: its import is
  // local and quick, and it is the command the reader already typed.
  const retry = rerunOf(args).command;
  try {
    const summary = await deployStaticTo(
      dir,
      { access_token: engine.token },
      { baseUrl: engine.url, workspaceId: engine.workspaceId, label: `Xano Engine ${engine.name}` },
      buildStaticEnv(engine.url, args.staticEnv),
      Object.keys(args.staticEnv).length > 0,
      args.staticHost,
      // Nothing to wait for: the engine serves the build once the upload returns.
      true,
      args.staticRouting,
      "--static",
      { serverRendered: true },
    );
    if (summary.serverBundle === "uploaded") {
      detail("Server half uploaded: the engine renders the site's dynamic routes.");
    }
    return summary;
  } catch (err) {
    const unknown = err instanceof Error && statesOutcomeUnknown(err.message);
    const tooOld = (err as { status?: unknown }).status === 501;
    const which = engineVersion === undefined ? "This Xano Engine" : `Xano Engine ${engineVersion}`;
    const message = tooOld
      ? `${which} cannot host a static site (HTTP 501): static hosting on a Xano Engine came in a later release. ` +
        "`xanosdk local update` moves this project to the newest one."
      : unknownStaticOutcome(err instanceof Error ? err.message : String(err), unknown);
    warn("The static-host upload failed — the backend deploy stands:", "static.upload-failed", [
      message,
      `Retry with \`${retry}\` (it re-imports the backend, which is quick on a Xano Engine).`,
    ]);
    process.exitCode = unknown ? EXIT_OUTCOME_UNKNOWN : EXIT_STATIC_FAILED;
    return { url: undefined, error: message, retry, completed: unknown ? "unknown" : "no" };
  }
}

/** `deploy <source>` read through its registry slot. */
async function parseDeploySource(raw: string): Promise<Exclude<Source, { kind: "file" }>> {
  const { requireBackendSlot, parseSlot } = await import("./backend-slot.js");
  const source = parseSlot(requireBackendSlot("deploy", undefined, "subject"), raw);
  // Only a kind-shaped word or a bare keyword reaches here (`looksLikeSource`),
  // and neither parses as a path.
  if (source.kind === "file") throw new Error(`Internal: "${raw}" parsed as a bundle path on the fetch arm.`);
  return source;
}

/**
 * Refuse the env and documentation-token flags for a fetched source, before
 * anything is signed into or fetched. They fill values into a compile, and a
 * fetched source is not compiled.
 */
function refuseValueFlagsForSource(args: ParsedArgs, raw: string, source: Exclude<Source, { kind: "file" }>): void {
  // The remedy for what was typed: an env var can be set afterwards, a
  // documentation token only arrives compiled in.
  const kinds = compileValueFlagKinds(args);
  const remedy = [
    kinds.env ? `Set an env var on the deployed backend afterwards with \`xanosdk env set NAME${contextFlags(args)}\`.` : undefined,
    kinds.docs ? DOC_TOKEN_REMEDY : undefined,
  ]
    .filter((r) => r !== undefined)
    .join(" ");
  refuseCompileValueFlags(
    args,
    raw,
    source.kind === "release"
      ? `a release is already built — it carries no env vars, and its API groups' documentation tokens are the ` +
          `ones it was cut with — so there is nothing for them to fill. ${remedy}`
      : `it is fetched, not compiled, and arrives with the env values and documentation settings it already holds. ${remedy}`,
    { command: "deploy" },
  );
}

/**
 * What a `--keep-data` merge left as it is live, for the summary document —
 * each key present only when it names something.
 */
function mergeLossFields(
  merged: KeepDataMergeResult | undefined,
): Pick<
  DeploySummary,
  | "droppedTables"
  | "droppedColumns"
  | "pairedColumns"
  | "retypedColumns"
  | "notNullKept"
  | "narrowedEnums"
  | "retargetedRefs"
  | "indexChanges"
  | "notNullTightened"
  | "removed"
  | "notLanded"
  | "unseededTables"
  | "renamedTables"
  | "unappliedDocumentation"
  | "unchangedEnv"
  | "canonicalChanges"
> {
  if (merged === undefined) return {};
  return {
    ...(merged.droppedTables.length > 0 ? { droppedTables: merged.droppedTables } : {}),
    ...(merged.droppedColumns.length > 0 ? { droppedColumns: merged.droppedColumns } : {}),
    ...(merged.pairedColumns.length > 0 ? { pairedColumns: merged.pairedColumns } : {}),
    ...(merged.retypedColumns.length > 0 ? { retypedColumns: merged.retypedColumns } : {}),
    ...(merged.notNullKept.length > 0 ? { notNullKept: merged.notNullKept } : {}),
    ...(merged.narrowedEnums.length > 0 ? { narrowedEnums: merged.narrowedEnums } : {}),
    ...(merged.retargetedRefs.length > 0 ? { retargetedRefs: merged.retargetedRefs } : {}),
    ...(merged.indexChanges.length > 0 ? { indexChanges: merged.indexChanges } : {}),
    ...(merged.notNullTightened.length > 0 ? { notNullTightened: merged.notNullTightened } : {}),
    ...(merged.removed.length > 0 ? { removed: merged.removed } : {}),
    ...(merged.notLanded.length > 0 ? { notLanded: merged.notLanded } : {}),
    ...(merged.unseededTables.length > 0 ? { unseededTables: merged.unseededTables } : {}),
    ...(merged.renamedTables.length > 0 ? { renamedTables: merged.renamedTables } : {}),
    ...(merged.unappliedDocumentation.length > 0 ? { unappliedDocumentation: merged.unappliedDocumentation } : {}),
    ...(merged.keptEnv.length > 0 ? { unchangedEnv: merged.keptEnv } : {}),
    ...(merged.canonicalChanges.length > 0 ? { canonicalChanges: merged.canonicalChanges } : {}),
  };
}

/**
 * How a redeploy's headline describes the URLs: unchanged, unless the merge
 * moved a public URL slug — then which, since every endpoint under the old one
 * stops answering.
 */
function urlsNote(merged: KeepDataMergeResult | undefined): string {
  const moved = merged?.canonicalChanges ?? [];
  if (moved.length === 0) return " (URL unchanged)";
  return ` (base URL unchanged; ${moved.map((m) => `${m.kind} "${m.name}" moved ${m.from} → ${m.to}`).join(", ")})`;
}

/**
 * Say what a release does not carry, once its archive is in hand.
 *
 * A release is stored without the workspace's env vars or its documentation
 * settings, and nothing about that is visible in the deploy's own output — the
 * flags that would fill them are refused for this source. What the landing
 * does with that depends on where it lands, which only the hosted arm knows
 * after the deploy: `landing` names the ephemeral a refresh kept, `"new"` is one
 * this run created, and absent (the local arm, which notes it before
 * deploying) says both.
 *
 * Measured live: a NEW ephemeral stood up from a release has every env var
 * unset and the documentation gate off, but a refresh of an existing one keeps
 * the env vars and workspace documentation settings it already had — the
 * replace brings the release's logic, not a blank workspace config. Saying
 * "left unset" there sends the reader to re-set values that are still in place.
 */
function noteReleaseCarriesNoEnv(
  raw: string,
  /**
   * The API groups whose docs stay gated (`gatedApiGroups`). A group's gate and
   * token are stored ON the group, so they travel inside the release — only the
   * WORKSPACE's documentation block does not. Measured: a gated group answers
   * 403 without a token on the new environment, and 200 with the source's.
   */
  gatedGroups: readonly string[],
  landing?: { readonly ephemeral: string; readonly created: boolean },
  /** This run's credential flags, for the printed commands (see `contextFlags`). */
  flags = "",
): void {
  if (!raw.startsWith("release:")) return;
  const release = `Release "${raw.slice("release:".length)}" carries no env vars and no workspace documentation settings`;
  if (landing !== undefined && !landing.created) {
    detail(
      `${release}; ephemeral ${landing.ephemeral} kept the ones it already had. Change an env var with \`xanosdk env set NAME${flags}\`.`,
    );
  } else {
    warn(
      `${release}.`,
      "release.no-env",
      [
        (landing !== undefined
          ? "The new environment has every env var unset and the workspace documentation gate off."
          : "A new environment stood up from it has every env var unset and the workspace documentation gate off; " +
            "one it refreshes keeps the ones it had.") + ` Set env vars afterwards with \`xanosdk env set NAME${flags}\`.`,
      ],
    );
  }
  if (gatedGroups.length === 0) return;
  const one = gatedGroups.length === 1;
  detail(
    `API group${one ? "" : "s"} ${gatedGroups.map((g) => `"${g}"`).join(", ")} keep${one ? "s" : ""} ${one ? "its" : "their"} ` +
      `own documentation gate: it travels with the group, token included — the token of the backend the ` +
      `release was cut from, which is not necessarily the one \`xanosdk secrets fill\` put in this project. ` +
      (landing !== undefined
        ? `\`xanosdk ephemeral export ${landing.ephemeral}${flags}\` writes it out (owner-only).`
        : "The landed backend's export carries it."),
  );
}

/** A fetched source as a human line names it: `tenant:tdra-… ("Prod")`. */
function shownSourceOf(f: { provenance: string; display?: string }): string {
  return f.display === undefined ? f.provenance : `${f.provenance} (${JSON.stringify(f.display)})`;
}

/**
 * Say that a copy of a running backend arrives with its tables empty.
 *
 * A live source is fetched through its export, which carries the schema and
 * not the rows — the same fact the same-ephemeral refusal gives as its reason.
 * Deploying ANOTHER environment in went through with nothing said, so a reader
 * met an empty copy of a populated backend and read it as a failed deploy. A
 * release is the exception: it carries whatever seed rows it was cut with.
 */
function noteLiveCopyCarriesNoRows(raw: string, display?: string, flags = ""): void {
  if (raw.startsWith("release:")) return;
  // Its own line, not a `detail`: what precedes it varies (the landing record's
  // clear, the success lines), and as a continuation it read as part of that.
  info(
    `Its tables are empty: a copy of "${raw}"${display === undefined ? "" : ` (${JSON.stringify(display)})`} carries its schema, not its rows. ` +
      `\`xanosdk release create <name> --from ${shellQuote(raw)} --seed${flags}\` cuts a release from it that carries rows.`,
  );
}

/**
 * Warn that a seeded release's password rows will not verify where it landed,
 * and return the columns for the summary (`passwordHashesUnverifiable`).
 *
 * A stored password is a hash keyed by the key material of the environment
 * that made it, which no archive carries. The release's rows land
 * byte-for-byte (measured: the destination holds exactly the source's hash),
 * and a DIFFERENT environment checks them under its own key — so every login
 * against those rows fails as a bad password, while the same rows seeded from
 * the entry file work, because the entry sends the plaintext and the
 * destination hashes it itself. Landed back on the environment the release
 * was cut from, the key is the one that made them and logins work (measured),
 * so that landing says nothing. Nothing this deploy could send changes either.
 *
 * `landedOn` is the ephemeral's name, or `undefined` for a Xano Engine, which
 * no release is ever cut from. Only when rows were written: a `--keep-data`
 * merge leaves the environment's own rows in place.
 */
async function notePasswordHashesDoNotTravel(
  credential: () => Promise<ResolvedAuth>,
  raw: string,
  columns: readonly string[],
  landedOn: string | undefined,
): Promise<string[] | undefined> {
  if (!raw.startsWith("release:") || columns.length === 0) return undefined;
  const release = raw.slice("release:".length);
  // Read only now, with something to warn about: a source that is no release never signs in.
  const origin = await passwordOrigin(await credential(), release);
  if (landedOn !== undefined && origin?.name === landedOn) return undefined;
  const where = landedOn === undefined ? "the Xano Engine" : `ephemeral "${landedOn}"`;
  warn(passwordHashesWarning(release, columns, where, "the deploy", origin?.phrase), "seed.password-hashes");
  return [...columns];
}

/** True when the bundle declares a table: with none, "its tables are empty" describes nothing. */
function carriesTables(bundle: string): boolean {
  try {
    const dbo = (JSON.parse(bundle) as { payload?: { dbo?: unknown } } | null)?.payload?.dbo;
    return Array.isArray(dbo) && dbo.length > 0;
  } catch {
    return true;
  }
}

/**
 * Say that a full replace from a bundle FILE left the tables empty.
 *
 * Seed rows travel beside the workspace JSON, compiled from the entry — a
 * `--bundle <path>` is the workspace JSON alone, so the replace clears every
 * table and writes nothing back. The same silence `noteLiveCopyCarriesNoRows`
 * closes for a fetched source: an empty backend after a clean deploy reads as
 * a failed one.
 */
function noteBundleFileCarriesNoRows(path: string, reset: boolean): void {
  // Its own line — see `noteLiveCopyCarriesNoRows`. Under `--reset` the
  // replace was asked for, so `--keep-data` is no remedy to offer.
  info(
    `Its tables are empty: the bundle file "${path}" carries the schema, not seed rows. ` +
      (reset
        ? "Deploy the entry file to seed them."
        : "Deploy the entry file to seed them, or pass `--keep-data` to keep the rows an environment already has."),
  );
}

/**
 * Refuse copying this project's engine into itself, BEFORE anything is
 * downloaded, started or stopped (KTD7).
 *
 * Compared by engine NAME, off the record and the path-derived name the
 * destination itself would use — no enumeration, so the refusal costs nothing.
 * Bare `local` IS this project's engine by definition, whatever the
 * record says. The replace that would follow empties the destination before it
 * imports, and here the destination is the source: the export would be read
 * from an engine the same run is about to replace, or restart, under it.
 */
function refuseSameEngine(source: Exclude<Source, { kind: "file" }> | undefined, dir: string): void {
  if (source?.kind !== "local") return;
  const own = getEngineRecord(dir)?.name ?? engineNameForProject(dir);
  if (source.name !== undefined && source.name !== own) return;
  throw new UsageError(
    `"${source.name === undefined ? "local" : `local:${source.name}`}" is this project's own ` +
      `engine (${own}), which is also where \`--local\` deploys — the same engine as source and ` +
      `destination. Nothing was downloaded or stopped. \`xanosdk deploy local\` stands its export up ` +
      `as an ephemeral; \`xanosdk deploy local:<name> --local\` copies another engine into this one.`,
    { hintFor: { command: "deploy" } },
  );
}

/**
 * Refuse deploying this project's ephemeral into itself, before anything is
 * fetched.
 *
 * The hosted twin of {@link refuseSameEngine}. A deploy with no `--to` lands on
 * the ephemeral this directory tracks, and a fetched source carries no rows, so
 * the full replace that follows empties every table of the environment it read
 * from, and reports success. Under `--keep-data` the merge has nothing to land,
 * so it is refused all the same, with that reason. Bare `ephemeral` IS the tracked one by definition.
 * Compared off the local record alone: no request, so the refusal costs nothing.
 */
export function refuseSameEphemeral(
  source: Exclude<Source, { kind: "file" }> | undefined,
  auth: ResolvedAuth,
  dir: string,
  /** This run's credential flags, for the remedies (see `contextFlags`). */
  flags = "",
  /** Whether this run merges keeping the rows (`--keep-data` without `--reset`). */
  keepsData = false,
): void {
  // `tenant:<name>` included: an ephemeral IS a tenant on the wire, so that
  // spelling fetches the same environment and the same replace empties it.
  if (source?.kind !== "ephemeral" && source?.kind !== "tenant") return;
  const record = getEnvironment(readEphemeralState(dir), auth);
  if (record === undefined) return;
  const own = record.name;
  // Its display name too: it is the name people repeat, and the refusal costs
  // nothing where a lookup by it would only fail as "no such name".
  const named = source.name === undefined || source.name === own || source.name === record.display;
  if (!named) return;
  const typed = source.name === undefined ? source.kind : `${source.kind}:${source.name}`;
  throw new UsageError(
    `"${typed}" is this project's own ` +
      `ephemeral (${own}), which is also where \`xanosdk deploy --ephemeral\` lands — the same environment as source and ` +
      `destination. ` +
      (keepsData
        ? `Merging it into itself would land its own export back onto it, so there is nothing to change. `
        : `A redeploy of it from itself would replace it with an export that carries no rows, so every table ` +
          `would come back empty. `) +
      `Nothing was fetched or changed.\n` +
      (keepsData
        ? `Redeploy the project with \`xanosdk deploy --ephemeral --keep-data${flags}\`, or merge another environment in with ` +
          `\`xanosdk deploy ephemeral:<other> --ephemeral --keep-data${flags}\`.`
        : `Redeploy the project with \`xanosdk deploy --ephemeral${flags}\` (add \`--keep-data\` to keep the rows), or copy ` +
          `another environment in with \`xanosdk deploy ephemeral:<other> --ephemeral${flags}\`.`),
    { hintFor: { command: "deploy" } },
  );
}

/**
 * Flags that only mean something beside another flag, keyed by that flag.
 *
 * Without their parent each was dropped silently: `--kind unit --concurrency 3`
 * with no `--test` exited 0 having run no tests, and the `--static-*` flags with
 * no `--static` exited 0 having published nothing. Refused rather than ignored,
 * for the reason {@link DESTINATION_ONLY} is — a run that exits 0 without doing
 * what a flag asked reads as the flag having worked.
 */
const DEPENDENT_FLAGS: ReadonlyArray<{
  readonly parent: string;
  readonly present: (args: ParsedArgs) => boolean;
  readonly flags: ReadonlyArray<{ readonly flag: string; readonly passed: (args: ParsedArgs) => boolean }>;
}> = [
  {
    parent: "--test",
    present: (a) => a.test,
    flags: [
      { flag: "--kind", passed: (a) => a.kind !== undefined },
      { flag: "--concurrency", passed: (a) => a.concurrency !== undefined },
    ],
  },
  {
    parent: "--static",
    present: (a) => a.static !== undefined,
    flags: [
      { flag: "--static-host", passed: (a) => a.staticHost !== undefined },
      { flag: "--static-routing", passed: (a) => a.staticRouting !== undefined },
      { flag: "--static-env", passed: (a) => Object.keys(a.staticEnv).length > 0 },
    ],
  },
];

function assertNoOrphanFlags(args: ParsedArgs): void {
  for (const group of DEPENDENT_FLAGS) {
    if (group.present(args)) continue;
    const names = group.flags.filter((f) => f.passed(args)).map((f) => f.flag);
    if (names.length === 0) continue;
    const one = names.length === 1;
    throw new UsageError(
      `${andList(names)} ${one ? "applies" : "apply"} only with ${group.parent}, and this deploy ` +
        `has none — nothing was deployed. Add ${group.parent}, or drop ${one ? "the flag" : "the flags"}.`,
      { hintFor: { command: "deploy" } },
    );
  }
}

/**
 * A `--lock` in a directory that is not there, refused before sign-in and any
 * write: found only when the compile writes the lock, it came after an
 * ephemeral could already have been created.
 */
function refuseMissingLockDir(args: ParsedArgs): void {
  const noDir = missingLockDir(args);
  // Exit 8, as every missing local input: the directory is not there.
  if (noDir !== undefined) {
    throw new LocalFileNotFoundError(`${noDir} Nothing was deployed.`, { hintFor: { command: "deploy" } });
  }
}

/**
 * A `--static` directory that is not there, refused beside the other paths —
 * before sign-in and before the compile, which it otherwise waited out to be
 * answered "Not signed in". Only absence here, in the same words the full check
 * uses: an empty or entry-less build is still judged by `assertStaticDir`.
 */
function refuseMissingStaticDir(args: ParsedArgs): void {
  if (args.static === undefined || existsSync(args.static)) return;
  throw new LocalFileNotFoundError(`--static ${args.static}: directory not found. Nothing was deployed.`, {
    hintFor: { command: "deploy" },
  });
}

export async function runDeployCommand(args: ParsedArgs): Promise<void> {
  try {
    await runDeploy(args);
  } catch (err) {
    // A no to a `--keep-data` merge's question (another source's objects):
    // nothing was written, and that was chosen — a decline exits 0, as every
    // command's does (E2E pass 27: exit 2). Both arms reach here from the
    // merge before its write, so nothing after it (a publish, a test) ran.
    if (err instanceof Error && err.name === "KeepDataDeclined") {
      info(err.message);
      return;
    }
    throw err;
  }
}

async function runDeploy(args: ParsedArgs): Promise<void> {
  // Checked here rather than left to the platform: an empty name was refused
  // only by the rename, after a whole compile, and a blank one passed it and
  // cleared the display name.
  if (args.name !== undefined && args.name.trim() === "") {
    throw new UsageError(
      "--name needs a display name with at least one visible character. Drop it to keep the " +
        "current name (a new ephemeral takes the release's or workspace's name).",
      { hintFor: { command: "deploy" } },
    );
  }
  // Trimmed because the platform trims what it stores: untrimmed, the run
  // printed and recorded a display name the ephemeral does not hold.
  if (args.name !== undefined) args = { ...args, name: args.name.trim() };

  // One destination value, computed before anything acts on it — including the
  // `--to` handoff, which would otherwise claim a run that named two.
  const destination = resolveDeployDestination(args);
  await assertLocalEngineUsable(args, destination);

  // Before the `--to` handoff, for the same reason the local refusal is:
  // below it, this flag would be carried into a release that ignores it.
  if (args.keepData && args.to !== undefined) {
    throw new UsageError(
      "`--keep-data` keeps an ephemeral's or a Xano Engine's rows across a redeploy, and " +
        "`--to` already merges — it empties tables only when `--replace` or `--reset-data` asks. " +
        "Drop `--keep-data`; `--to` without those keeps the destination's data as it always has.",
      { hintFor: { command: "deploy" } },
    );
  }

  // Before the handoff too: below it, each of these is carried into a release
  // that reads none of them.
  assertNoEphemeralFlags(args);
  // Before sign-in: a replace deletes every static host but the one its
  // publish re-creates, so a publish to any other one cannot succeed.
  refuseStaticHostAReplaceClears(args, args.to !== undefined ? args.replace : !args.keepData || args.reset);
  // AFTER the `--to` refusal: `--to workspace --kind unit` answered "add
  // --test", and adding it was then refused — the first refusal has to be the
  // one whose fix works.
  assertNoOrphanFlags(args);
  // Before either arm: a --static-env pair is published whichever way it goes.
  warnSecretLookingStaticEnv(args.staticEnv);

  // A real destination is a different command underneath: it merges from a
  // local build rather than full-replacing a throwaway environment.
  if (args.to !== undefined) return runDeployToDestination(args, args.to);

  // Only after the `--to` handoff: these are legal there, and meaningless here.
  assertNoDestinationFlags(args);
  // Wall-clock from the top of the command — the compile and the auth read are
  // part of what "how long did the deploy take" means to whoever typed it.
  const startedAt = Date.now();

  // `--reset` only overrides `--keep-data`; alone it asks for what a deploy
  // already does. The override itself is reported where the arm is chosen.
  if (args.reset && !args.keepData) {
    info("`--reset` changes nothing here: it only overrides `--keep-data`, and without it a deploy already replaces the environment.");
  }

  const { looksLikeSource, resolveProjectEntry, fetchSourceArchive, passwordSeedColumns, archiveSeedContent, gatedApiGroups } = await import(
    "./deploy-source.js"
  );
  // An argument naming a backend is fetched, not compiled. Deliberately decided
  // before auth so the two arms diverge once, at the top, rather than at every
  // step that assumes a local build.
  const fetching = args.file !== undefined && looksLikeSource(args.file);
  // Parsed here, through the slot the registry declares, rather than first
  // inside the fetch: a kind this command does not know is refused listing
  // every spelling `<source>` takes — a bundle path included — before a
  // credential is read, and the local checks below need the kind.
  const sourceSpec = fetching ? await parseDeploySource(args.file!) : undefined;
  if (sourceSpec !== undefined) refuseValueFlagsForSource(args, args.file!, sourceSpec);
  if (destination.kind === "local") {
    refuseSameEngine(sourceSpec, process.cwd());
    // A Xano Engine selects no credential, so `--profile` is refused rather
    // than dropped — unless the SOURCE is hosted, which reads it (R9).
    const { refuseProfileForLocal } = await import("./tracked-backend.js");
    // The file and origin flags are refused just below, in the deploy's own words.
    refuseProfileForLocal(args.profile, sourceSpec === undefined ? ["local"] : ["local", sourceSpec.kind], undefined, {});
    // `--config`, `--local-auth` and `--origin` choose a credential, refused on the same grounds.
    const { refuseCredentialFlagsForLocal } = await import("./local-engine-choice.js");
    refuseCredentialFlagsForLocal(args, sourceSpec === undefined ? ["local"] : ["local", sourceSpec.kind]);
  }

  if (!fetching) {
    // A bare `xanosdk deploy` inside a project means its entry. Outside one it
    // is still a usage problem, answered by the same message as before.
    if (args.file === undefined && args.bundle === undefined) {
      const entry = resolveProjectEntry(process.cwd());
      if (entry !== undefined) args = { ...args, file: entry };
    }
    // Cheapest refusal first: answering a bare deploy with "not signed in"
    // would answer the wrong question.
    assertBundleInput(args, { command: "deploy" });
    refuseValueFlagsBesideBundle(args, { command: "deploy" });
    // Paths before sign-in: a typo in one is answered as the typo it is.
    assertBundleFile(args, { command: "deploy" });
    assertValueFiles(args, { command: "deploy" });
    refuseMissingLockDir(args);
  }
  // Whatever the source: a fetched backend publishes a `--static` build too.
  refuseMissingStaticDir(args);

  if (destination.kind === "local") {
    // An engine on this machine needs no Xano account, but a deploy whose INPUT
    // is a hosted source still needs a credential to fetch that source. Handed
    // down as a provider rather than read here: the resolver calls it for a
    // hosted source and never for a Xano Engine, so `deploy local:<other>
    // --local` signs in nowhere.
    const { memoCredential } = await import("./tracked-backend.js");
    return deployToLocalEngine(
      args,
      destination,
      fetching ? memoCredential(() => getAccessToken(args)) : undefined,
      { startedAt },
    );
  }

  // Then auth, before the compile: `getAccessToken` reads (and at most
  // refreshes) a cached credential, while `loadBundleText` may run a whole
  // compile and write the lockfile. Signed out, compiling first would make you
  // pay for the compile before being told to log in; this way it lands in a
  // second. A missing entry first: "not signed in" answers the wrong question.
  if (!fetching) assertEntryFile(args);
  const auth = await getAccessToken(args);
  refuseSameEphemeral(sourceSpec, auth, process.cwd(), contextFlags(args), args.keepData && !args.reset);
  // The compile's empty-env / doc-token refusals name a bare `env pull` / `pull`
  // only when it reaches a backend with THIS credential.
  await noteRunScopeFor(auth);

  // Toolchain plugins import BEFORE the compile below, which loads the user's
  // entry and unregisters the TypeScript loader behind it — a later dynamic
  // import would trip over that in a source checkout.
  const { discoverToolchainPlugins } = await import("./toolchain-modules.js");
  const toolchain = await discoverToolchainPlugins(process.cwd(), {
    frozen: args.frozenLock === true,
  });

  // A fetched backend carries no seed content: seed rows resolve from a local
  // registry at compile time, and a backend that already exists has whatever
  // data it has. Inventing an empty seed would be a claim the archive acts on.
  const loaded = fetching
    ? await fetchSourceArchive(async () => auth, args.file!, process.cwd()).then((f) => ({
        // Decoded back out of the archive rather than carried alongside it: the
        // downstream steps want the workspace text, and reading it from the
        // bytes about to be uploaded proves they are well-formed first.
        bundle: JSON.stringify(decodeWorkspaceArchive(f.archive)),
        bundleObject: undefined as Bundle | undefined,
        source: f.provenance,
        // The headline's name for it: the handle, and beside it what people call it.
        shownSource: shownSourceOf(f),
        sourceDisplay: f.display,
        // Read only by a merge, to name the new tables whose rows it does not write.
        content: archiveSeedContent(f.archive),
        nonPublicSeedValues: [] as never[],
        archive: f.archive,
      }))
    : // The lock write waits for the pre-import refusals (a `--static-host`
      // the environment does not hold, a seed leak): a refused deploy leaves
      // `xano.lock` as it found it. `deployEphemeral` commits it before its
      // first write.
      await loadBundleText(args, { command: "deploy" }, { withSeed: true, deferLockWrite: true }).then((l) => ({
        ...l,
        archive: undefined as Uint8Array | undefined,
        shownSource: shownInput(l.source),
        sourceDisplay: undefined as string | undefined,
      }));
  const { bundle, source, content, nonPublicSeedValues } = loaded;
  const passwordColumns = fetching && loaded.archive !== undefined ? passwordSeedColumns(loaded.archive) : [];
  if (!fetching) await ignoreBackendSecretFilesRead(args);

  // Before anything is UPLOADED: a refusal here must leave nothing deployed.
  // Resolving the credential above is not a write — it touches the auth host,
  // never the target — so the guard still stands between the scan and the first
  // byte of the environment.
  if (args.static !== undefined) {
    await assertNoSeedLeaks(args.static, nonPublicSeedValues);
  }

  if (content.length > 0 && !fetching) {
    const hosted = "files" in loaded ? loaded.files.length : 0;
    const rows =
      (content.length === 1 ? "1 seed content file" : `${content.length} seed content files`) +
      (hosted === 0 ? "" : ` and ${hosted === 1 ? "1 hosted file" : `${hosted} hosted files`}`);
    // `--reset` settles the arm before anything is read: it always replaces, so
    // "only if" would describe a choice this run does not have.
    detail(
      args.keepData && !args.reset
        ? `Bundling ${rows} (sent only if this deploy replaces the environment).`
        : `Bundling ${rows} (full replace re-seeds cleanly).`,
    );
  }
  // The derived-artifact hooks, after the compile and BEFORE the first byte
  // leaves. The tree a plugin writes describes the SOURCE, so a deploy that
  // fails after this point still leaves a correct tree — and a tree never
  // claims something shipped that did not.
  {
    const { runBundleHooks } = await import("./toolchain-hooks.js");
    // Lazily, because this module only type-imports from `cli.js` — a value
    // import between the two would close a cycle.
    const { readVersion } = await import("./cli.js");
    await runBundleHooks(
      toolchain.loaded,
      {
        // The compile already produced this object; only the `--bundle <path>`
        // branch has nothing but text, and it pays the parse alone.
        bundle: loaded.bundleObject ?? (JSON.parse(bundle) as Bundle),
        // NOT `args.file` when fetching: on that branch it is a source
        // spec (`release:main`), not a path, and nothing local was compiled.
        // `entry` absent is the documented signal for "the project did not
        // compile this" — the same signal `--bundle <path>` sends — and it is
        // what lets a plugin decline rather than render a remote backend over
        // the tree describing this repo's source.
        entry: fetching ? undefined : args.file,
        cwd: process.cwd(),
        command: "deploy",
        frozen: args.frozenLock === true,
        sdkVersion: readVersion(),
      },
      "; nothing was deployed",
    );
  }

  // A fetched archive already carries its hosted files; a compiled one gets them here.
  const archive = loaded.archive ?? encodeWorkspaceArchive(bundle, [...content, ...("files" in loaded ? loaded.files : [])]);

  // WHEN this runs is decided per destination by the deploy* function that calls
  // it — see `PublishStatic`. What it must never do is fail the backend deploy,
  // so the whole body sits inside one guard either way.
  let staticSummary: DeploySummary["static"];
  const staticDir = args.static;
  const publishStatic =
    staticDir === undefined
      ? undefined
      : async (env: Parameters<PublishStatic>[0]): Promise<StaticPublishSummary> => {
          const staticEnv = buildStaticEnv(env.baseUrl, args.staticEnv);
          const explicit = Object.keys(args.staticEnv).length > 0;
          // Everything here is inside the guard, target resolution included: a
          // throw out of it would take the backend deploy with it.
          try {
            // The ephemeral itself (its base URL, workspace id 1), so backend
            // AND frontend live in the same disposable environment.
            const target: StaticTarget = { baseUrl: env.baseUrl, workspaceId: 1, label: env.label };
            staticSummary = await deployStaticTo(
              staticDir,
              auth,
              target,
              staticEnv,
              explicit,
              args.staticHost,
              args.skipLiveness,
              args.staticRouting,
              "--static",
              { rerun: staticRetryCommand(staticDir, `ephemeral:${env.name}`, args, undefined) },
            );
          } catch (err) {
            // Never fails the backend deploy: the frontend is a separate
            // artifact, and refusing to deploy the backend because its
            // frontend upload failed would be a worse trade. The distinct exit
            // code still reports it — and so does the document, which is all a
            // `--json` reader sees.
            const unknown = err instanceof Error && statesOutcomeUnknown(err.message);
            // A lost answer's "check before retrying" named no check. The check
            // IS the retry: a publish replaces the host's build, so running it
            // again settles the outcome either way and prints the URL.
            const message = unknownStaticOutcome(err instanceof Error ? err.message : String(err), unknown);
            // The retry travels in the document too: its error says "the retry
            // below", and a `--json` reader sees no line below.
            staticSummary = {
              url: undefined,
              error: message,
              retry: staticRetryCommand(staticDir, `ephemeral:${env.name}`, args, err),
              completed: unknown ? "unknown" : "no",
            };
            // A republish after a failed import: nothing of this deploy stands,
            // and the import's error says what the failed republish left.
            if (env.republish === true) return staticSummary;
            warn(
              "The static-host upload failed — the backend deploy stands:",
              "static.upload-failed",
              [
                message,
                // `publish`, not `deploy --static`: a redeploy would re-import the
                // backend that just landed to retry an upload that has nothing to do with it.
                // `--static-routing` must be carried too — dropping it lets the retry
                // silently re-infer routing the caller had explicitly overridden, and
                // it would then 200 the wrong document instead of failing loudly.
                staticRetryHint(staticDir, `ephemeral:${env.name}`, args, err),
              ],
            );
            // 9, not 3, when the upload may have landed: 3 says the site did not.
            process.exitCode = unknown ? EXIT_OUTCOME_UNKNOWN : EXIT_STATIC_FAILED;
          }
          return staticSummary;
        };

  const removedOut: {
    removed?: Record<string, { guid: string }>;
    removedGuids?: string[];
    storedColumns?: Map<string, Record<string, string>>;
  } = {};
  // What the deploy landed is said by an interrupt only while it runs.
  const summary: DeploySummary = await deployEphemeral(auth, {
    archive,
    bundle,
    content,
    source,
    args,
    startedAt,
    publishStatic,
    commitLock: "commitLock" in loaded ? loaded.commitLock : undefined,
    warnOrphansUncommitted: "warnOrphansUncommitted" in loaded ? loaded.warnOrphansUncommitted : undefined,
    lock: "classifiedLock" in loaded ? loaded.classifiedLock : undefined,
    shownSource: loaded.shownSource,
    ...("commitLock" in loaded && loaded.commitLock !== undefined && args.file !== undefined
      ? { lockPath: (await import("./cli.js")).resolveLockPath(args, args.file) }
      : {}),
    removedOut,
    ...(!fetching && args.bundle === undefined && args.file !== undefined ? recordedEntry(args.file) : {}),
    compiled: !fetching && args.bundle === undefined,
  }).finally(() => noteLanded(undefined));

  if (staticSummary !== undefined) summary.static = staticSummary;
  // What this project now has on its ephemeral, for a later
  // `deploy --to tenant:<it> --prune` (see `lock/landed.ts`). Both arms leave
  // the ephemeral holding exactly what was sent — a `--keep-data` merge deletes
  // what the project no longer defines too — so both record a replace.
  // Kept in the uncommitted `.xano/ephemeral.json`, never the lock: see `landing-record.ts`.
  if (summary.ephemeral !== undefined) {
    const { landingLockPath, recordLanding, recordForeignLanding } = await import("./landing-record.js");
    const dest = { kind: "ephemeral" as const, name: summary.ephemeral.name };
    const { storedColumnsAfter } = await import("../deploy/live-diff.js");
    const sent = JSON.parse(bundle) as unknown;
    // The column storage the next merge's retype notes predict inserts by:
    // a replace created every column as declared; a merge kept each one's.
    // Whatever the source — a `--bundle` or a release lands the same tables.
    const stored = summary.data === "kept" ? removedOut.storedColumns : storedColumnsAfter(sent, undefined, new Map(), "rebuild");
    // A fetched backend or a `--bundle` file was not compiled here: its objects
    // are this project's only when every identity matches the project's lock,
    // and otherwise the replace CLEARS the record (said) — recording a foreign
    // bundle's objects as this project's let a later `--prune` delete them.
    if (fetching || args.bundle !== undefined) {
      summary.landingRecord = recordForeignLanding({
        lockPath: landingLockPath(args),
        instance: auth.instance,
        dest,
        bundle: sent,
        mode: "replace",
        ...(stored !== undefined ? { stored } : {}),
        // What the merge deleted leaves the lock as an entry merge's does.
        ...(removedOut.removedGuids !== undefined ? { removedGuids: removedOut.removedGuids, removedBy: "merge" as const } : {}),
      });
    } else {
      const { landedIdentities } = await import("../lock/landed.js");
      summary.landingRecord = recordLanding({
        lockPath: landingLockPath(args, { ...(args.file !== undefined ? { entryFile: args.file } : {}), fromProject: false }),
        instance: auth.instance,
        dest,
        update: {
          mode: "replace",
          identities: withStoredColumns(landedIdentities(sent), stored),
          ...(removedOut.removed !== undefined ? { removed: removedOut.removed } : {}),
        },
        removedBy: "merge",
      });
    }
  } else {
    summary.landingRecord = null;
  }
  if (fetching) {
    noteReleaseCarriesNoEnv(
      args.file!,
      gatedApiGroups(JSON.parse(bundle) as unknown),
      summary.ephemeral === undefined
        ? undefined
        : { ephemeral: summary.ephemeral.name, created: summary.created !== false },
      contextFlags(args),
    );
    if (summary.data === "replaced" && carriesTables(bundle)) noteLiveCopyCarriesNoRows(args.file!, loaded.sourceDisplay, contextFlags(args));
    // After the import, when the ephemeral it landed on is known: landed back
    // on the one the release was cut from, the hashes verify and nothing is said.
    if (summary.data === "replaced") {
      const unverifiable = await notePasswordHashesDoNotTravel(
        async () => auth,
        args.file!,
        passwordColumns,
        summary.ephemeral?.name,
      );
      if (unverifiable !== undefined) summary.passwordHashesUnverifiable = unverifiable;
    }
  } else if (args.bundle !== undefined && summary.data === "replaced" && carriesTables(bundle)) {
    noteBundleFileCarriesNoRows(args.bundle, args.reset === true);
  }

  // Discovery computed this before the compile and warned about it on stderr.
  // Carried into the document too — see `DeploySummary.unconfigured`.
  noteUnconfigured(summary, toolchain.unconfigured);

  // Before the tests and before `--open`: this is the line that tells whoever
  // typed the command what changed on their disk, and burying it under a test
  // run is how a write nobody noticed becomes a surprise.
  // A site an earlier deploy published that still serves (a `--keep-data`
  // merge leaves it standing) reads the backend URL at runtime, as a publish
  // in this run does: `.env.local` is left alone, as `--no-dev-env` says.
  const tracked = getEnvironment(readEphemeralState(process.cwd()), auth);
  const staticServing = tracked?.static_url !== undefined && tracked.static_down !== true;
  await syncDevEnvAfterDeploy(args, summary, process.cwd(), { staticServing });

  // Tests run LAST: after the import and after any static publication, so
  // `--test --static` reports on the environment as a caller will actually meet
  // it. A failure sets the exit code but never retracts the deploy — the
  // environment IS deployed, and saying otherwise would be false. Same trade the
  // static-upload guard makes.
  // `runDeployedTests` never throws — see its header. The deploy has already
  // happened by this point, and a summary lost to an unreachable test endpoint
  // would report no URL for an environment that is live.
  if (args.test) summary.testRun = await runDeployedTests(auth, summary, args);

  // `--open`: the frontend when there is one — that is the thing a person wants
  // to look at — else the backend base URL. A no-op under `XANO_NO_BROWSER`,
  // which the shared helper already honors, so CI and the test suite are unaffected.
  if (args.open) openDeployed(summary);

  // stdout is the machine-readable data channel: emit the projected, secret-free
  // summary as JSON when it's piped or redirected — or when `--json` asked for it
  // at a terminal. On an interactive terminal without the flag the progress lines
  // already carry the URL, so a raw dump would just be noise. The elapsed time is
  // deliberately NOT in here: it is a human reading aid, and a wrapper diffing
  // this document must not see a field that changes on every run.
  if (isMachineOutput(args)) writeJson(summary);
}

/**
 * Point a scaffolded project's dev server at the backend this deploy just made.
 *
 * Keyed on STATIC PUBLISHING, not on the destination: a deployed frontend is
 * handed the backend URL at runtime (`window.XANO_HOST`), so writing a dev file
 * as well would be writing a value nothing reads. Every other deploy writes,
 * hosted destination included — the frontend that needs pointing is the one
 * running on this machine, and where the backend landed does not change that.
 *
 * Never fails the deploy. It runs after the import has committed, so a file
 * that cannot be written is a step the developer now does by hand, not a reason
 * to report a live environment as a failure — the same trade the static-upload
 * guard makes. The refusal's own message already names the URL to use meanwhile.
 *
 * Exported for the tests, which assert on this seam rather than on a file: what
 * matters here is WHEN it runs.
 */
export async function syncDevEnvAfterDeploy(
  args: ParsedArgs,
  summary: DeploySummary,
  cwd: string = process.cwd(),
  opts: { staticServing?: boolean } = {},
): Promise<void> {
  if (args.noDevEnv || summary.url === undefined) return;
  // A published frontend gets the URL at runtime; a deploy that reported no URL
  // has nothing to point anything at. The file is left alone then, so a block
  // still naming an older backend is said — the local dev server reads it.
  // A FAILED publish (`static.error`) served nothing, so the local frontend is
  // still the one that needs pointing.
  if (opts.staticServing === true || (summary.static !== undefined && summary.static.error === undefined)) {
    const { staleDevEnv } = await import("./dev-env-sync.js");
    let stale: ReturnType<typeof staleDevEnv>;
    try {
      stale = staleDevEnv(cwd, summary.url);
    } catch {
      stale = undefined;
    }
    if (stale !== undefined) {
      detail(
        `${stale.label} still points your dev server at ${stale.url}; set ${stale.variable}=${summary.url} there to use this deploy.`,
      );
    }
    return;
  }

  const { syncDevEnv } = await import("./dev-env-sync.js");
  try {
    const written = syncDevEnv(cwd, summary.url);
    // `undefined` is a project with no scaffolded frontend: nothing was written
    // and nothing is worth saying about it.
    if (written === undefined) return;
    detail(
      `Pointed ${written.label} at this deploy (${written.variable}) — restart your dev ` +
        `server to pick it up. \`--no-dev-env\` skips this.`,
    );
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err), "dev-env.sync-failed");
  }
}

/**
 * Record the toolchain modules the project never configured, if there are any.
 *
 * OMITTED rather than emitted empty, so the field's PRESENCE is the signal and
 * a reader needs no length check to branch on it. Separate from the assignment
 * that would otherwise express it inline because that is the whole rule, and an
 * edit that made it unconditional would turn every clean deploy's document into
 * one carrying an empty array that means nothing.
 */
export function noteUnconfigured(
  summary: DeploySummary,
  unconfigured: readonly string[],
): DeploySummary {
  if (unconfigured.length > 0) summary.unconfigured = [...unconfigured];
  return summary;
}

/** `--open`'s target: the deployed frontend if one was published, else the backend. */
function openDeployed(summary: DeploySummary): void {
  const url = summary.static?.url ?? summary.url;
  if (url === undefined) {
    warn("--open had no URL to open — the deploy reported none.", "deploy.open-no-url");
    return;
  }
  detail(`Opening ${url}`);
  openBrowser(url);
}

/** The wait's opening label, before any read has said how many there are. */
const WAITING_LABEL = "Waiting for microservices…";
/** Shown while the import request is in flight — the deploy's longest silent leg. */
const IMPORTING_LABEL = "Uploading and importing the workspace…";

/**
 * Say that the frontend moved, once, and only when it did.
 *
 * The backend URL survives a refresh; the static one does not. A replace clears
 * the environment's hosting, so a replacing re-deploy serves the frontend from
 * a NEW host, and the old URL (a bookmark, a shared link, a README) stops
 * serving the moment this one appears. Said here because this is the moment
 * the cost is paid.
 *
 * `previous` is the frontend SERVING just before this deploy — the only one
 * whose loss it may take the blame for. `downBefore` is one an earlier replace
 * already took down: its URL still moved, and that is said without blaming
 * this deploy. Silent for a first publish into an environment (nothing
 * stopped serving) and when the URL is unchanged.
 * Exported for the tests.
 */
export function noteStaticUrlChange(
  previous: string | undefined,
  current: string,
  arm: DeployArm,
  downBefore?: string,
): void {
  if (previous === undefined) {
    if (downBefore !== undefined && downBefore !== current) {
      detail(`This frontend URL is new — the previous one (${downBefore}) stopped serving at an earlier replace.`);
    }
    return;
  }
  if (previous === current) return;
  detail(
    arm.arm === "replace"
      ? `This frontend URL is new — a replacing deploy clears the environment's static hosting, so ` +
          `the previous one (${previous}) no longer serves, and the rows were re-seeded. ` +
          "`--keep-data` merges instead, which leaves both standing."
      : `This frontend URL is new — the previous one (${previous}) no longer serves.`,
  );
}

/**
 * Say why a `--keep-data` deploy is replacing anyway. Silent otherwise: without
 * the flag a replace is simply what a deploy does, and a merge is announced by
 * its own preview.
 */
function announceArm(arm: DeployArm, kind: "ephemeral" | "local", landedBefore = false, seeded = true): void {
  if (arm.arm !== "replace" || arm.skipped === undefined) return;
  const why: Record<KeepDataSkipped, string> = {
    new: "Nothing to keep yet — this environment is new, so it is replaced and seeded. Later deploys with `--keep-data` keep its rows.",
    // An ephemeral expires or is deleted; a Xano Engine's rows go when its
    // process restarts. Each told its own reason.
    recreated:
      kind === "ephemeral"
        ? "Nothing to keep — the ephemeral recorded for this project is gone (it expired, or was deleted), so a new one is created, replaced and seeded."
        : "Nothing to keep — the environment recorded for this project is gone (the engine restarted), so this one is replaced and seeded.",
    // Two different stories behind the same missing marker, each told as it
    // is: the landing record is written only by a completed deploy, so when it
    // names objects here, a deploy did land and only the marker is gone.
    "never-filled": landedBefore
      ? "Nothing to keep that can be vouched for — an earlier deploy from this project landed here, but the " +
        "marker that its rows are this project's is missing from `.xano/ephemeral.json`, so it is replaced and seeded. " +
        "Later deploys with `--keep-data` keep its rows."
      : "Nothing to keep — no deploy from this project into this environment has completed yet, so it is replaced and seeded.",
    reset: seeded
      ? "`--reset` wins over `--keep-data` — replacing the environment and re-seeding it."
      : "`--reset` wins over `--keep-data` — replacing the environment. This deploy carries no seed rows, so its tables come back EMPTY.",
  };
  info(why[arm.skipped]);
}

/** Why a `--keep-data` deploy replaces after all, as a deferred refusal opens. */
const KEEP_DATA_REPLACES: Readonly<Record<KeepDataSkipped, string>> = {
  new: "`--keep-data` has nothing to keep — this deploy creates the environment",
  recreated: "`--keep-data` has nothing to keep — the environment this project recorded is gone, and this deploy creates another",
  "never-filled": "`--keep-data` cannot keep this environment's data — nothing records that its rows are this project's",
  reset: "`--reset` wins over `--keep-data`",
};

/**
 * A `--keep-data` compile lets a declared env name with no value through: a
 * merge keeps whatever the target holds for it. An environment that holds data
 * `--keep-data` cannot vouch for is REPLACED instead, and a replace would clear
 * that value — so the refusal the compile deferred is thrown here, before any
 * write. A new or recreated environment holds nothing to clear.
 */
async function refuseEnvClearedByFallbackReplace(arm: DeployArm): Promise<void> {
  if (arm.arm !== "replace") return;
  const { envRefusalIfReplaced, docTokenRefusalIfReplaced } = await import("./cli.js");
  // A replace writes the workspace's documentation block whatever the
  // environment held, so a gate with no token is refused on every replace arm.
  const docs = docTokenRefusalIfReplaced(KEEP_DATA_REPLACES[arm.skipped ?? "never-filled"]);
  if (docs !== undefined) throw new Error(docs);
  if (arm.skipped !== "never-filled") return;
  const refusal = envRefusalIfReplaced(KEEP_DATA_REPLACES["never-filled"]);
  if (refusal !== undefined) throw new Error(refusal);
}

/**
 * What the republish after a failed replace left serving, for the import's
 * error: the new URL and the backend it runs against, or that it failed too
 * and the publish that retries it. Exported for the tests.
 */
export function republishNote(
  republished: StaticPublishSummary,
  unknown: boolean,
  /** When the republish failed: the frontends warned about before the import, and what a read found of each. */
  frontends?: { warned: readonly string[]; states: Readonly<Record<string, FrontendAfterFailure>> },
): string {
  if (republished.url === undefined) return failedRepublishNote(republished, unknown, frontends);
  const checked =
    republished.verified === true ? ", verified live" : republished.verified === false ? ", not yet confirmed live" : "";
  const published = `The frontend was republished at ${republished.url}${checked} — a replace clears it`;
  return unknown
    ? `${published}. It runs against whichever backend the environment now holds: its previous one, or this ` +
        `deploy's if the import landed after all.`
    : `${published} — and runs against this environment's PREVIOUS backend until a deploy imports cleanly.`;
}

/**
 * The republish after a failed replace failed too. Nothing of this deploy
 * landed — the import did not, and neither did the frontend — so what is said
 * is what now serves, as read after the failure: a frontend the replace's clear
 * took down serves nothing, and the publish that brings it back is named.
 */
function failedRepublishNote(
  republished: StaticPublishSummary,
  unknown: boolean,
  frontends: { warned: readonly string[]; states: Readonly<Record<string, FrontendAfterFailure>> } | undefined,
): string {
  const head = unknown ? "The import's outcome is unknown" : "The import was refused";
  // Its first line only: a transport failure carries its own aftermath
  // ("Nothing was sent — retry.") on the next, which spliced into this
  // sentence read as a second, contradicting story (E2E pass 22).
  const failure = ((republished.error ?? "no URL was returned").trim().split("\n")[0] ?? "").trim().replace(/\.+$/, "");
  const retry = republished.retry !== undefined ? ` Run \`${republished.retry}\` to publish it again.` : "";
  const warned = frontends?.warned ?? [];
  const by = (s: FrontendAfterFailure): string[] => warned.filter((u) => (frontends?.states[u] ?? "unknown") === s);
  const down = by("down");
  const serving = by("serving");
  const unasked = by("unknown");
  const unaskedText =
    unasked.length === 0
      ? ""
      : ` The frontend at ${unasked.join(", ")} could not be reached to check — the replace's clear may have taken it down.`;
  if (down.length > 0) {
    return (
      `${head}, the replace had cleared the frontend, and republishing it failed: ${failure} — nothing serves at ` +
      `${down.join(", ")}.${unaskedText}${retry}`
    );
  }
  if (serving.length > 0 && unasked.length === 0) {
    return (
      `${head}, and republishing the frontend failed: ${failure} — the frontend at ${serving.join(", ")} still ` +
      `serves its previous build. Deploy again once the import goes through; that publishes this build with it.`
    );
  }
  return `${head}, and republishing the frontend failed: ${failure}.${unaskedText}${retry}`;
}

/**
 * Whether a failed import's outcome is unknown — its answer was lost, or the
 * instance failed a merge part-way — rather than refused (the instance answered and
 * wrote nothing).
 */
function isUnknownImportOutcome(err: unknown): boolean {
  return err instanceof Error && statesOutcomeUnknown(err.message);
}

/** This run as a paste-ready rerun and its withheld-secret note, for an error that ends on one. */
function rerunOf(args: ParsedArgs): { command: string; note: string } {
  const retry = retryCommand(args);
  return { command: retry.command, note: withheldNote(retry.withheld) };
}

/**
 * The newest published engine, for explaining an import the engine answered
 * 501 — read only then, from the update check's cache when it is fresh (the
 * deploy's own pin check just filled it), bounded when it is not. Undefined for
 * any other failure, and whenever it cannot be known.
 */
async function latestEngineRelease(err: unknown): Promise<string | undefined> {
  const { ImportHttpError } = await import("../deploy/import.js");
  if (!(err instanceof ImportHttpError) || err.status !== 501) return undefined;
  const { resolveEnginePlatform } = await import("../deploy/local-engine-config.js");
  const platform = resolveEnginePlatform();
  if (platform === undefined) return undefined;
  const { latestKnownVersion } = await import("../deploy/local-engine-update-check.js");
  return latestKnownVersion({ platform });
}

/**
 * What a keep-data merge needs from this run beyond the bundle: the tables the
 * compile's lock pins, with the `lock rename` / `lock prune` fix-ups spelled as
 * the build's orphan warning spells them (the rename gate); `--yes`; and a
 * terminal question when someone can answer one (the foreign-delete gate).
 */
async function mergeGuards(
  args: ParsedArgs,
  lock: LockFile | undefined,
  /** The outgoing bundle and whether this run compiled it from source — for the canonicals it pins. */
  outgoing?: { bundle: string; compiled: boolean },
): Promise<Pick<KeepDataMergeRequest, "lockPins" | "allowForeignDeletes" | "confirm" | "pinned">> {
  const interactive = process.stdin.isTTY === true && !isMachineOutput(args);
  // The slugs pinned in code, sent as `deploy --to` sends them: the merge then
  // serves each as declared or refuses, instead of keeping the one live.
  const pinned =
    outgoing === undefined
      ? []
      : (await import("./release-command.js")).pinnedCanonicalGuids(outgoing.bundle, lock, outgoing.compiled);
  const guards: Pick<KeepDataMergeRequest, "lockPins" | "allowForeignDeletes" | "confirm" | "pinned"> = {
    ...(pinned.length > 0 ? { pinned } : {}),
    allowForeignDeletes: args.yes === true,
    ...(interactive
      ? {
          confirm: async (q: string) =>
            (await import("./prompt.js")).confirm(q, {
              flag: "--yes",
              refusal: { details: { deployed: false }, ...yesRerun(args, "deploy") },
            }),
        }
      : {}),
  };
  const entry = args.file;
  if (lock === undefined || entry === undefined) return guards;
  const tables = new Map<string, string>();
  const replaced = new Map<string, string>();
  for (const [key, e] of Object.entries(lock.objects)) {
    if (!key.startsWith("dbo:")) continue;
    if (typeof e.guid === "string") tables.set(e.guid, key.slice("dbo:".length));
    for (const guid of e.replaced ?? []) replaced.set(guid, key.slice("dbo:".length));
  }
  const { orphanFixUps, resolveLockPath, composedChildren } = await import("./cli.js");
  const { clearReplacedCommand } = await import("./keep-data-merge.js");
  const lockPath = resolveLockPath(args, entry);
  const run = (line: string | undefined) => (line ?? "").replace(/^(renamed|deleted)\? run: /, "");
  const keys = Object.keys(lock.objects);
  const codePinned = outgoing === undefined ? undefined : codePinnedAgainstDisk(outgoing.bundle, lockPath, lock);
  return {
    ...guards,
    lockPins: {
      tables,
      ...(codePinned !== undefined ? { codePinned } : {}),
      clearReplaced: (name) => clearReplacedCommand(name, lockPath),
      ...(replaced.size > 0 ? { replaced } : {}),
      fixUps: (name, newName) => {
        const [rename, prune] = orphanFixUps(`dbo:${name}`, entry, lockPath, undefined, [], newName);
        return { rename: run(rename), prune: run(prune) };
      },
      keyFixUps: (key, newName) => {
        if (!(key in lock.objects)) return undefined;
        const [rename, prune] = orphanFixUps(key, entry, lockPath, undefined, composedChildren(key, keys), newName);
        return { rename: run(rename).replace(/ \(it moves .*\)$/, ""), prune: run(prune) };
      },
      entries: new Map(
        Object.entries(lock.objects).flatMap(([key, e]) => (typeof e.guid === "string" ? [[key, e.guid] as const] : [])),
      ),
    },
  };
}

/**
 * The tables whose def pins its own guid, judged against the lock on disk —
 * the one this build read, since a deploy writes its lock only once the merge
 * passes its refusals — and classified by the lock this build merged.
 * `undefined` when either does not read.
 */
function codePinnedAgainstDisk(bundle: string, lockPath: string, classified: LockFile): Map<string, CodePinnedTable> | undefined {
  try {
    return codePinnedTables(JSON.parse(bundle) as unknown, readLockFile(lockPath), classified);
  } catch {
    return undefined;
  }
}

/**
 * ` --yes` for a printed `ephemeral delete` when no terminal can answer its
 * confirmation — without it, the command as printed refuses (E2E pass 24).
 */
function offTerminalYes(): string {
  return process.stdin.isTTY === true ? "" : " --yes";
}

/**
 * The line a failed FIRST deploy ends on: the environment it created, which
 * this project now tracks, and both ways on. Exported for the tests.
 */
export function createdButFailedNote(
  name: string,
  unknown: boolean,
  args: ParsedArgs,
  landedUnresolved = false,
  /**
   * `untracked`: not recorded locally. `futile`: the failure is in what was
   * stored, so the identical redeploy cannot land — only the delete is offered.
   */
  opts: { untracked?: boolean; futile?: boolean } = {},
): string {
  // Not recorded locally: a redeploy would create another, so the delete is the one way on.
  if (opts.untracked === true) {
    return (
      `Created ephemeral ${name}, but could not record it in .xano/ephemeral.json, so nothing here tracks it. ` +
      `Delete it with \`xanosdk ephemeral delete ${shellQuote(name)}${contextFlags(args)} --yes\`, then make .xano/ writable and redeploy.`
    );
  }
  const remove = `\`xanosdk ephemeral delete ${shellQuote(name)}${contextFlags(args)}${offTerminalYes()}\``;
  if (opts.futile === true) {
    return (
      `Created ephemeral ${name} (tracked in .xano/ephemeral.json); it holds nothing yet, and redeploying from this ` +
      `source fails the same way — delete it with ${remove}.`
    );
  }
  const retry = retryCommand(args);
  const holds = landedUnresolved
    ? "it holds this deploy, but its hostedFile() fields point at nothing"
    : unknown
      ? "whether it holds this deploy is unknown"
      : "it holds nothing yet";
  return (
    `Created ephemeral ${name} (tracked in .xano/ephemeral.json); ` +
    `${holds} — redeploy with ` +
    `\`${retry.command}\`, or ${remove}.${withheldNote(retry.withheld)}`
  );
}

/**
 * After a failed import into a tracked environment that was never filled —
 * so {@link noteKeptFilledMarker} has nothing to vouch for — whose outcome is
 * unknown or which never sent: the literal rerun, with any withheld-secret note.
 * Exported for the tests.
 */
export function noteReplaceRerun(err: unknown, args: ParsedArgs): unknown {
  if (!(err instanceof Error) || (!isUnknownImportOutcome(err) && !(err instanceof ImportNotSentError))) return err;
  const retry = retryCommand(args);
  // The import's own sentence already says running it again is safe; this
  // names what to run (E2E pass 30: "safe to run again" named no command).
  const when = certificateFailureCode(err) !== undefined ? "Once the certificate is trusted" : "Once it is reachable";
  err.message = `${err.message}\n${when}, run \`${retry.command}\`.${withheldNote(retry.withheld)}`;
  return err;
}

/**
 * After a failed import into a filled environment: say the rows are still
 * vouched for when the outcome is unknown. Whatever part of the import landed,
 * the rows a filled environment held are still this project's, and a
 * `--keep-data` re-run merges into them. A refusal (the
 * instance answered and wrote nothing) needs no sentence: its own error says so.
 *
 * Said IN the error, so the `--json` error document carries it too, and the
 * command it names is this run's own (every flag, no secret — see
 * {@link retryCommand}) with `--keep-data` added and `--reset` dropped: a bare
 * `deploy --keep-data` refused for the `--env-var` values it no longer had.
 * Returns the error, amended in place so its class and exit code stay.
 * Exported for the tests.
 */
export function noteKeptFilledMarker(err: unknown, filled: boolean, args: ParsedArgs): unknown {
  if (!filled || !(err instanceof Error) || !isUnknownImportOutcome(err)) return err;
  const retry = retryCommand(args, { add: ["--keep-data"], drop: ["--reset"] });
  // A replace's own rerun too: its sentence says running it again is safe, so
  // the command it means is named, not only the merge.
  const again = retryCommand(args);
  const replace = again.command === retry.command ? "" : `Once it is reachable, \`${again.command}\` replaces it again. `;
  err.message =
    `${err.message}\n${replace}Whichever way it went, the environment's rows are still recorded as ` +
    `this project's, so \`${retry.command}\` merges into them rather than replacing them.${withheldNote(retry.withheld)}`;
  return err;
}

const DUPLICATE_GUID = /Duplicate (\S+) guid: (\S+?)\./;

/** The backend a deploy argument fetches from — `undefined` for a path. */
function fetchedSourceOf(file: string | undefined): { kind: "release" | "tenant" | "ephemeral" | "workspace" | "local"; name?: string } | undefined {
  if (file === undefined) return undefined;
  const colon = file.indexOf(":");
  const kind = colon < 0 ? file : file.slice(0, colon);
  const name = colon < 0 ? undefined : file.slice(colon + 1).trim();
  if (kind === "release" || kind === "tenant") return name ? { kind, name } : undefined;
  if (kind === "ephemeral" || kind === "local") return name ? { kind, name } : { kind };
  if (kind === "workspace" && colon < 0) return { kind };
  return undefined;
}

/**
 * A fetched backend the instance refused for a guid two of its objects share:
 * the duplicate is in what the source stores, so no redeploy of it can land.
 */
export function isFetchedDuplicateGuid(err: unknown, file: string | undefined): boolean {
  return err instanceof Error && fetchedSourceOf(file) !== undefined && DUPLICATE_GUID.test(err.message);
}

/**
 * A replace the instance refused because the archive carries two objects of
 * one type under one guid, said in the reader's terms.
 *
 * A deploy keeps the archive's identities (see `preserveGuids`), and the
 * instance refuses a kept identity two objects share — the check runs only
 * when identities are kept, so `tenant deploy` of the same release, which
 * gives every object a new one, lands where this does not. For a fetched
 * source the duplicate is in what that backend stores; nothing this project
 * sends changes it, so the fix is made where it is authored. `flags` are the
 * run's context flags, carried into a printed command.
 * Returns the error unchanged when it is anything else. Exported for tests.
 */
export function explainDuplicateArchiveGuid(err: unknown, file: string | undefined, flags = ""): unknown {
  if (!(err instanceof Error)) return err;
  const dup = DUPLICATE_GUID.exec(err.message);
  if (dup === null) return err;
  const [, section, guid] = dup;
  const keeps = `A deploy keeps an archive's identities, and the instance refuses one that two objects share`;
  const source = fetchedSourceOf(file);
  let why: string;
  if (source === undefined) {
    why = `The archive carries two ${section} objects under guid ${guid}. ${keeps} — give one of them its own guid and deploy again.`;
  } else if (source.kind === "release") {
    why =
      `Release "${source.name}" was stored with two ${section} objects under guid ${guid}. ${keeps}; \`xanosdk tenant deploy\` gives every object ` +
      `a new identity, which is why it can land the same release. Re-cut the release from a backend that holds ` +
      `one ${section} per guid to deploy it here.`;
  } else {
    const label =
      source.kind === "workspace" ? "The workspace" : source.name === undefined ? `The ${source.kind}` : `${source.kind === "tenant" ? "Tenant" : source.kind === "ephemeral" ? "Ephemeral" : "Xano Engine"} ${source.name}`;
    const reland =
      source.kind === "tenant"
        ? `, land it there again with \`xanosdk deploy --to ${shellQuote(`tenant:${source.name!}`)}${flags}\``
        : source.kind === "workspace"
          ? `, land it there again with \`xanosdk deploy --to workspace${flags}\``
          : source.kind === "ephemeral"
            ? `, deploy it there again from the project that tracks it`
            : `, land it there again`;
    why =
      `${label} holds two ${section} objects under guid ${guid}. ${keeps}, so redeploying from it fails the same way ` +
      `until the duplicate is fixed where it is authored: give one of them its own guid${reland}, then run this deploy again.`;
  }
  // The same error, extended: its class and exit code are what the caller reads.
  err.message = `${err.message}\n${why}`;
  return err;
}

/** The summary fields that say what became of the rows. */
function dataFields(arm: DeployArm): Pick<DeploySummary, "data" | "keepDataSkipped"> {
  if (arm.arm === "merge") return { data: "kept" };
  return { data: "replaced", ...(arm.skipped === undefined ? {} : { keepDataSkipped: arm.skipped }) };
}

/**
 * The spinner's label for a poll that just landed: the readiness ratio, so a long
 * wait shows movement rather than a fixed sentence. Falls back to the bare label
 * when nothing was startable (a ratio out of 0 would only confuse).
 */
function waitingLabel(microservices: MicroserviceSummary[]): string {
  const { ready, startable } = readyRatio(microservices);
  return startable === 0 ? WAITING_LABEL : `${WAITING_LABEL} (${ready}/${startable} ready)`;
}

/**
 * After a committed import, wait for the environment's microservices and report
 * what each one is doing.
 *
 * Prints nothing when the workspace declares none, which is the common case and
 * the reason this costs a single request rather than a visible step. Never
 * fails the deploy: the import has already committed, so an unconfirmed or
 * broken microservice is reported and folded into the summary while the exit
 * code stays with the import — the same posture the static-host rollout check
 * takes. Returns `undefined` when there was nothing to report.
 *
 * Exported for tests.
 */
export async function verifyMicroservices(
  auth: ResolvedAuth,
  baseUrl: string,
  opts: MicroserviceCheck,
  waitOpts: WaitOptions = {},
): Promise<MicroserviceSummary[] | undefined> {
  if (opts.skip) return undefined;

  // The wait can run for minutes with nothing to print until it settles, so the
  // spinner carries the progress: each poll refreshes the ratio in place, and
  // `stop()` erases the line so only the outcome below survives.
  //
  // Started by the first poll that finds something to wait FOR, never before
  // the first read. Off a terminal the label is a printed line rather than an
  // erasable one, and started up front it announced a wait on every deploy —
  // including the common one with no microservice to wait on.
  let spin: Spinner | undefined;
  let result;
  try {
    // An env's own internal workspace id is always 1 — the same pair the import
    // just used, so this reads exactly what was written.
    result = await waitForMicroservices(auth, { baseUrl, workspaceId: 1 }, {
      ...waitOpts,
      onPoll: (rows) => {
        if (spin === undefined && rows.some(isAwaited)) spin = spinner(WAITING_LABEL);
        spin?.update(waitingLabel(rows));
        waitOpts.onPoll?.(rows);
      },
    });
  } catch (err) {
    // Without the read's "Nothing was changed — retry.": the deploy landed, so
    // "retry" read as "deploy again". What to run instead is the status check.
    const message = withoutReadAftermath(err instanceof Error ? err.message : String(err));
    const remedy = `xanosdk ephemeral get ${opts.name !== undefined ? shellQuote(opts.name) : "<env>"}${opts.flags ?? ""}`;
    warn("Could not read microservice status (the backend deployed fine):", "microservice.status-unreadable", [
      message,
      `Check them with \`${remedy}\`.`,
    ]);
    opts.onReadError?.({ message, remedy });
    return undefined;
  } finally {
    spin?.stop();
  }

  const { microservices, timedOut, hadFailure } = result;
  if (microservices.length === 0) return undefined;

  const { ready, startable } = readyRatio(microservices);
  // Each microservice's line, under the warning when there is one — so `--json` carries them.
  const lines = microservices.map(microserviceLine);
  let listed = false;

  if (hadFailure) {
    // The engine has already decided this one is broken; waiting longer cannot
    // change it. Non-zero WITHOUT the flag, matching the static-host rule that
    // a failed upload exits distinctly while an unconfirmed rollout does not.
    warn("Some microservices failed to start:", "microservice.failed", lines);
    listed = true;
    failDeploy();
  } else if (timedOut) {
    warn(`Microservices are still starting (${ready}/${startable} ready) — they should come up shortly:`, "microservice.starting", lines);
    listed = true;
    // "Should come up shortly" is a guess, and in CI nobody is there to find
    // out. `--require-microservices` is how a caller says the deploy is only
    // done when the workload is actually running.
    if (opts.requireReady) failDeploy();
  } else if (startable === 0) {
    // Every microservice is manual or disabled: nothing was started, and saying
    // "ready (0/0)" would imply otherwise.
    info("No microservices to start:");
  } else {
    success(`Microservices ready (${ready}/${startable})`);
  }
  if (!listed) for (const line of lines) detail(line);
  if (timedOut && !hadFailure) {
    detail(
      `Re-check with \`xanosdk ephemeral get ${opts.name ?? "<env>"}${opts.flags ?? ""}\`, or skip this wait next time with --skip-liveness.`,
    );
    if (!opts.requireReady) {
      detail("Fail the deploy on this instead of warning: --require-microservices.");
    }
  }

  return microservices;
}

/**
 * Record that the deployed workload is not running, without disturbing an exit
 * code an earlier step already claimed.
 *
 * `--static` can already have set its own distinct code by the time this runs;
 * overwriting it would rename a failure the caller is already being told about.
 * First one to fail names the outcome.
 */
function failDeploy(): void {
  if (!process.exitCode) process.exitCode = EXIT_MICROSERVICE_NOT_READY;
}

/**
 * The message a deploy gets when the instance has ephemeral environments turned
 * off.
 *
 * An ephemeral is the only thing `deploy` writes to, so on such an instance the
 * documented happy path — `xanosdk deploy` → URL — ended at a raw `ERROR_FATAL`
 * 500 that named neither the cause nor what to do about it. The capability
 * cannot be read before the call, so the failure is where the answer belongs.
 *
 * There is no fallback destination to offer, so the answer is the instance's,
 * not a flag's: the feature has to be turned on. What CAN still be done locally
 * is said too, since it is what unblocks the next few minutes.
 */
export function ephemeralDisabledError(source: string): Error {
  return new Error(
    "Ephemeral environments are not enabled on this instance, so there is nothing for " +
      `\`xanosdk deploy ${source} --ephemeral\` to create.\n` +
      "Ask whoever administers the instance to enable them.\n" +
      `Until then \`xanosdk deploy ${source}\` runs it on the Xano Engine on this machine, \`xanosdk export\` ` +
      "still writes the bundle, and `xanosdk preflight` still checks the round-trip, without needing one.",
  );
}

/**
 * A readiness wait that failed — timed out, or its lookup lost — on an
 * ephemeral that EXISTS: said with its name, that this project recorded it,
 * and both ways on (retry onto it, or delete it). Nothing was imported.
 * Exported for tests.
 */
export function notReadyError(err: unknown, name: string, flags: string, created: boolean, retry?: RetryCommand): Error {
  const head = closeSentence((err instanceof Error ? err.message : String(err)).split("\n")[0]!);
  // A wait whose every late poll got no answer (a 5xx, a dropped connection)
  // never learned whether it is ready: exit 8, the documented retry (E2E pass
  // 29: exit 1). One that answered "not ready" keeps its own exit.
  const unanswered = isUnansweredPoll(err);
  const failure = new Error(
    `${head}\n` +
      `${created ? `Ephemeral "${name}" was created and is` : `Ephemeral "${name}" is`} recorded in .xano/ephemeral.json, ` +
      `but ${unanswered ? "whether it is ready could not be read" : "it is not ready yet"}, so nothing was imported. \`${retry?.command ?? `xanosdk deploy --ephemeral${flags}`}\` retries onto it; ` +
      `\`xanosdk ephemeral delete ${name}${flags}${offTerminalYes()}\` removes it.${withheldNote(retry?.withheld ?? [])}` +
      `${unanswered ? " The poll got no answer (a server error or a network failure), so this run exits 8." : ""}`,
    { cause: err },
  );
  return unanswered ? Object.assign(failure, { exitCode: 8 }) : failure;
}


/**
 * What a merge onto an ephemeral whose outcome is unknown advises: the tables
 * it now holds, read with this run's credential. An ephemeral has no preview to
 * run again — `--dry-run` belongs to `--to` — so the advice is a read.
 */
export function ephemeralStateCheck(display: string, name: string, flags: string): string {
  // The definition, not the rows: a merge changes columns, indexes and objects,
  // and only the exported backend shows whether those landed.
  return (
    `Check whether it landed in what ${display} now defines — ` +
    `\`xanosdk ephemeral export ${shellQuote(name)} --format multidoc --path -${flags}\` prints its backend — before retrying.`
  );
}

/**
 * The advice after a `--to` merge whose outcome is unknown: this run again as a
 * preview — the exact command, with `--dry-run` added and no secret reprinted.
 */
export function toStateCheck(args: ParsedArgs, display: string): string {
  const retry = retryCommand(args, { add: ["--dry-run"] });
  return `Preview it again with \`${retry.command}\` to see ${display}'s current state before retrying.${withheldNote(retry.withheld)}`;
}

/**
 * After a create: say when another live ephemeral under the same parent
 * carries the display name this one was given — most often one an earlier
 * create's lost answer left behind, which nothing here tracks, so this deploy
 * made a second one beside it. The handles are named so the other can be
 * deleted. `recorded` is this project's own gone or expired one, which is not
 * news. A list that cannot be read says nothing: a courtesy, not a gate.
 */
async function warnSameDisplayName(
  auth: ResolvedAuth,
  parentWorkspaceId: number,
  created: Pick<EphemeralSummary, "name" | "display">,
  recorded: string | undefined,
  flags: string,
): Promise<void> {
  const display = created.display;
  if (display === undefined || display === created.name) return;
  let same: EphemeralSummary[];
  try {
    same = (await listEphemeral(auth, { parentWorkspaceId })).filter(
      (e) => e.display === display && e.name !== created.name && e.name !== recorded && !isExpired(e.expiresAt),
    );
  } catch {
    return;
  }
  if (same.length === 0) return;
  const handles = same.map((e) => e.name);
  const one = handles.length === 1;
  warn(
    `${one ? "Another ephemeral is" : `${handles.length} other ephemerals are`} also named "${display}" ` +
      `(${handles.join(", ")}) — this deploy created ${created.name} beside ${one ? "it" : "them"}.`,
    "ephemeral.duplicate-name",
    [
      `If ${one ? "it is" : "they are"} left over (a create whose answer was lost), delete ${one ? "it" : "them"} with ` +
        `${handles.map((h) => `\`xanosdk ephemeral delete ${shellQuote(h)}${flags}${offTerminalYes()}\``).join(", ")}.`,
    ],
  );
}

/**
 * A create that got no answer, or failed inside the instance: the ephemeral may
 * exist, recorded nowhere. Said with HOW to check — the list that would show
 * it, with this run's credential flags — as the delete names `ephemeral get`.
 * Anything that is not an unknown outcome passes through as it is.
 */
export function unknownCreateOutcome(err: unknown, display: string, flags: string, retry?: RetryCommand): unknown {
  if (!(err instanceof Error) || !/may or may not have taken effect/.test(err.message)) return err;
  const head = closeSentence(err.message.split("\n")[0]!);
  // The literal rerun, not "run the deploy again" (E2E pass 29).
  const again = retry?.command ?? `xanosdk deploy --ephemeral${flags}`;
  // Both answers the list can give, each with its step: a listed one exists and
  // nothing here tracks it, so a retry would create a second beside it.
  const message =
    `${head}\nThe request was sent, so ephemeral "${display}" may or may not have been created — check with ` +
    `\`xanosdk ephemeral list${flags}\` before retrying. If it is listed, it exists and this project does not ` +
    `track it: delete it with \`xanosdk ephemeral delete <handle>${flags}${offTerminalYes()}\` and run \`${again}\`, or keep it ` +
    `and merge into it with \`xanosdk deploy --to tenant:<handle>${flags}\` (a retry as it is creates a second ` +
    `one beside it). ` +
    `If it is not listed, run \`${again}\` again.${withheldNote(retry?.withheld ?? [])}`;
  // A transport failure stays one, for whatever reads it as the network's.
  return err instanceof TransportError
    ? new TransportError(message, err.timeout, { cause: err.cause })
    : new Error(message, { cause: err });
}

/** An entry or bundle path as the step line shows it: from where the user typed (`-` is stdin). */
function shownInput(source: string): string {
  return source === "-" ? source : displayPath(source);
}

/**
 * A refresh compiled from another entry than the one that last landed on this
 * ephemeral — a second entry of the project (`xano/admin.ts` over `xano/index.ts`),
 * or a scratch file no project owns — swaps the whole backend, and both are this
 * project's, so the foreign-object gate
 * sees nothing to ask about. Said, then asked like that gate: `--yes`, a yes on
 * the terminal, or refused off one with the exact rerun. Nothing is asked when
 * either entry is unknown (a `--bundle`, a fetched backend, an older record).
 */
async function gateEntrySwap(
  args: ParsedArgs,
  label: string,
  previous: string | undefined,
  entry: string | undefined,
  arm: "merge" | "replace",
): Promise<void> {
  if (previous === undefined || entry === undefined || previous === entry) return;
  const what =
    arm === "replace"
      ? `this deploy of ${entry} replaces that backend with this one`
      : `this merge of ${entry} removes what that backend declared and this one does not`;
  warn(`${label} was last deployed from ${previous}; ${what}.`, "ephemeral.entry-changed");
  if (args.yes === true) return;
  const question = `Deploy ${entry} over the backend from ${previous} on ${label}?`;
  const { rerun, note } = yesRerun(args, "deploy");
  const details = { deployed: false, previousEntry: previous, entry };
  if (process.stdin.isTTY !== true || isMachineOutput(args)) {
    throw new CliError(
      "SDK_USAGE",
      `${label} was not deployed: it would have asked: ${question}\n` +
        `Re-run as \`${rerun}\` to answer yes without being asked.${note}`,
      { exitCode: 1, details: { reason: "needs-confirmation", ...details } },
    );
  }
  const { confirm } = await import("./prompt.js");
  if (await confirm(question, { flag: "--yes", refusal: { details, rerun, note } })) return;
  const { KeepDataDeclined } = await import("./keep-data-merge.js");
  throw new KeepDataDeclined(label, "deployed");
}

/**
 * The entry a deploy compiled, as the ephemeral's record keeps it: relative to
 * the project directory, both sides through their real paths (a symlinked
 * temp or home directory otherwise reads as outside it). An entry outside the
 * project (a scratch file no project owns) is recorded as the `../` path it
 * is, so the entry-changed gate always has the entry to compare.
 */
function recordedEntry(file: string): { entry?: string } {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const rel = relative(real(process.cwd()), real(resolve(file))).split(sep).join("/");
  if (rel === "") return {};
  return { entry: rel.startsWith("../") || isAbsolute(rel) ? rel : `./${rel}` };
}

/** The lock entries pinning what a `--keep-data` merge deleted, keyed as the lock keys them. */
function keepDataRemovedEntries(merged: KeepDataMergeResult | undefined, lock: LockFile | undefined): Record<string, { guid: string }> {
  if (merged === undefined || lock === undefined || merged.removedGuids.length === 0) return {};
  const gone = new Set(merged.removedGuids);
  const out: Record<string, { guid: string }> = {};
  for (const [key, entry] of Object.entries(lock.objects)) {
    if (entry.guid !== undefined && gone.has(entry.guid)) out[key] = { guid: entry.guid };
  }
  return out;
}

/**
 * The refusal for a bare deploy in a project whose ephemeral is tracked under
 * ANOTHER credential profile only — the one every other command gives (see
 * `otherCredentialRefusal`), with `--name` as the way to make a separate one
 * here on purpose. Records for another host or workspace under THIS profile
 * are not refused: nothing is tracked where this deploy lands, and it makes one.
 */
async function refuseOtherProfileEphemeral(state: ReturnType<typeof readEphemeralState>, auth: ResolvedAuth): Promise<void> {
  const current = auth.profile?.name ?? DEFAULT_PROFILE;
  const underOther = Object.keys(state.environments).some((k) => k.includes("/") && k.slice(0, k.indexOf("/")) !== current);
  if (!underOther) return;
  const refusal = otherCredentialRefusal(
    state,
    auth,
    `or pass \`--name <display>\` to create a separate ephemeral under this one. Nothing was created`,
    { hintFor: { command: "deploy" } },
  );
  if (refusal === undefined) return;
  const { reachableFirst } = await import("./env-target.js");
  throw await reachableFirst(refusal, auth);
}

/**
 * The refusal for a `--keep-data` deploy in a project whose ephemeral is
 * tracked under this credential for ANOTHER workspace on this instance: the
 * rows to keep are there, and a new environment here would start empty. A
 * plain deploy makes one here (see {@link refuseOtherProfileEphemeral}); asking
 * to keep data is refused the way `release create` refuses the same state —
 * unless this workspace is one the credential cannot reach: then the create the
 * refusal offers would fail too, and that is the refusal instead.
 */
async function refuseKeepDataElsewhere(state: ReturnType<typeof readEphemeralState>, auth: ResolvedAuth): Promise<void> {
  const mine = environmentKey(auth);
  const sameHost = mine.slice(0, mine.lastIndexOf("/") + 1);
  if (!Object.keys(state.environments).some((k) => k !== mine && k.startsWith(sameHost))) return;
  const refusal = otherCredentialRefusal(
    state,
    auth,
    `or run without \`--keep-data\` to create a separate, freshly seeded ephemeral in workspace ${auth.workspaceId}. Nothing was created`,
    { hintFor: { command: "deploy" } },
  );
  if (refusal === undefined) return;
  const { reachableFirst } = await import("./env-target.js");
  throw await reachableFirst(refusal, auth);
}

/**
 * After a rename that failed, what the ephemeral is called now. A failure whose
 * request may have reached the server is read back: `renamed` when it holds the
 * new name, `unknown` when the read gets no answer. A failure that sent nothing
 * left the name as it was.
 */
async function reconcileRename(
  err: unknown,
  auth: ResolvedAuth,
  name: string,
  display: string,
): Promise<{ renamed: boolean; unknown: boolean }> {
  if (!(err instanceof Error) || !statesOutcomeUnknown(err.message)) return { renamed: false, unknown: false };
  try {
    const now = await getEphemeral(auth, { parentWorkspaceId: auth.workspaceId, name });
    if (now === null) return { renamed: false, unknown: true };
    return { renamed: now.display === display, unknown: false };
  } catch {
    return { renamed: false, unknown: true };
  }
}

/** How long a create guard stands before it is read as abandoned, whatever its owner. */
const CREATE_GUARD_STALE_MS = 15 * 60_000;

/**
 * Take the project's create guard, or refuse as busy: held from the read of
 * the tracked ephemeral until a new one is recorded, so two deploys started
 * together in one project never both create (E2E pass 46: both created, one
 * record survived). Busy is exit 8 with this command line — nothing was
 * created, and once the other run has recorded its ephemeral this one deploys
 * onto it.
 */
async function takeCreateGuard(dir: string, args: ParsedArgs): Promise<HeldLock> {
  const { tryLock } = await import("../util/file-lock.js");
  const lockPath = join(dir, ".xano", "deploy.lock");
  const lock = tryLock(lockPath, { staleMs: CREATE_GUARD_STALE_MS });
  if ("release" in lock) return lock;
  const shown = displayPath(lockPath);
  const retry = retryCommand(args, { creates: true });
  const holder = lock.heldBy;
  const { hostname } = await import("node:os");
  const where = holder?.host !== undefined && holder.host !== hostname() ? ` on ${holder.host}` : "";
  const pid = holder === undefined ? "" : ` (pid ${holder.pid}${where})`;
  throw new CliError(
    "SDK_ERROR",
    `Another deploy in this project${pid} is deciding which ephemeral to deploy to, so this one did not start.\n` +
      `Nothing was created. Once it has finished, run \`${retry.command}\` again.${withheldNote(retry.withheld)}\n` +
      `If no deploy is running in this project, its guard was left behind: remove \`${shown}\` and run it again.`,
    { exitCode: 8, details: { reason: "deploy-in-progress", rerun: retry.command, lockFile: shown } },
  );
}

async function deployEphemeral(
  auth: ResolvedAuth,
  ctx: Parameters<typeof deployEphemeralGuarded>[1],
): Promise<DeploySummary> {
  const dir = process.cwd();
  // The record check first: a tree that cannot take the record — or a record
  // that cannot be read, whose ephemeral may be live — is refused as that, not
  // as busy, and before anything is created.
  const { assertReadWritable } = await import("./writable.js");
  assertReadWritable(ephemeralStatePath(dir));
  const guard = await takeCreateGuard(dir, ctx.args);
  try {
    return await deployEphemeralGuarded(auth, ctx, guard);
  } finally {
    guard.release();
  }
}

async function deployEphemeralGuarded(
  auth: ResolvedAuth,
  ctx: {
    archive: Uint8Array;
    bundle: string;
    /** Seed content the archive carries — read by a merge only to name unseeded tables. */
    content: readonly SeedContentFile[];
    source: string;
    args: ParsedArgs;
    startedAt: number;
    publishStatic?: PublishStatic;
    /**
     * The compile's deferred `xano.lock` write. Run once the import LANDED —
     * as the local arm does (E2E pass 28), and as the landing record is
     * written only by a completed deploy. A refusal, a create that failed or
     * whose answer was lost (exit 9), an environment that never became ready,
     * or an import that failed or whose outcome is unknown leaves the lock as
     * it was (E2E pass 29): the identities it would record derive from names,
     * so the next run derives the same ones, and a lock rewritten for a deploy
     * that never landed is a diff to commit for nothing.
     */
    commitLock?: (opts?: { pruned?: ReadonlySet<string> }) => void;
    /**
     * The orphan warning {@link commitLock} would have said: an import that
     * fails or is refused says it instead, so a refused `--keep-data` merge
     * still prints the `lock rename` an export prints for the same tree.
     */
    warnOrphansUncommitted?: () => void;
    /** The lock this compile classified, for the keep-data rename gate. */
    lock?: LockFile;
    /**
     * Filled with the lock entries a `--keep-data` merge deleted the objects
     * of, for the caller's landing record to drop from the lock's `objects`
     * as a prune's are.
     */
    removedOut?: {
      removed?: Record<string, { guid: string }>;
      removedGuids?: string[];
      storedColumns?: Map<string, Record<string, string>>;
    };
    /** The local entry compiled, relative to the project directory — absent for a fetched backend or a `--bundle`. */
    entry?: string;
    /** Whether this run compiled the bundle from source (not a fetched backend, not a `--bundle`). */
    compiled?: boolean;
    /** `source` as a headline names it: a fetched backend's display name beside its handle. */
    shownSource?: string;
    /** The `xano.lock` {@link commitLock} writes, checked writable before anything is created. */
    lockPath?: string;
  },
  /** Released once this run has decided its ephemeral and recorded a new one. */
  createGuard: HeldLock,
): Promise<DeploySummary> {
  const { archive, bundle, content, source, args, startedAt, publishStatic } = ctx;
  let lockCommitted = false;
  const commitLock = (pruned?: ReadonlySet<string>): void => {
    if (lockCommitted) return;
    lockCommitted = true;
    ctx.commitLock?.(pruned === undefined ? undefined : { pruned });
  };
  // The parent workspace is where the ephemeral is *created*: the one the
  // credential is bound to, never a hard-coded 1 (instances number workspaces
  // from their own sequence, so a fixed 1 404s "Invalid workspace" anywhere the
  // first workspace isn't 1) and never a flag.
  const parentWorkspaceId = auth.workspaceId;
  // Ephemeral state is ALWAYS the project directory, never the global cache —
  // even when auth came from the shared global cache. That's deliberate: it keys the active
  // ephemeral to the folder you're deploying from, so different projects (and
  // parallel deploys) each track their own environment independently.
  const dir = process.cwd();
  // Every path below writes the record (and a compiled run its lock): a tree
  // that cannot take them is refused before an environment is created for it.
  const { assertReadWritable, assertWritable } = await import("./writable.js");
  assertReadWritable(ephemeralStatePath(dir));
  if (ctx.lockPath !== undefined) assertWritable(ctx.lockPath, "build without a lock with `--no-lock`");
  const state = readEphemeralState(dir);
  const stored = getEnvironment(state, auth);
  // Tracked under ANOTHER profile, and nothing under this one: a bare deploy
  // would quietly create a second ephemeral beside it, where every other
  // command refuses with the `--profile` remedy. Refused the same way — before
  // anything is written — unless `--name` asks for a separate one here.
  if (stored === undefined && args.name === undefined) {
    await refuseOtherProfileEphemeral(state, auth);
    if (args.keepData && !args.reset) await refuseKeepDataElsewhere(state, auth);
  }

  // Decide refresh (existing, live) vs. create (none tracked, or gone/expired).
  // A lookup that got no answer is exit 8 "a network failure — retry", as
  // `deploy ephemeral:<name>` says it: never read as gone, which would create.
  let target: EphemeralSummary | null = null;
  if (stored) {
    const existing = await lookupEphemeral(auth, stored.name);
    if (existing && !isExpired(existing.expiresAt)) target = existing;
  }
  const created = target === null;
  // A refresh creates nothing: the guard has done its work.
  if (!created) createGuard.release();
  const flags = contextFlags(args);
  // Tracked, but not ready: a create whose readiness wait failed recorded it
  // (below), and importing into an environment still provisioning fails. Ready
  // means `state: "ok"` and nothing else — the waiter's own rule — so a tenant
  // that answers with no state is waited on (and, if it keeps answering none,
  // refused the way the wait refuses it), never imported into unverified.
  if (target !== null && target.state !== "ok") {
    const pending = target;
    target = await withSpinner(`Waiting for ${pending.name} to become ready…`, () =>
      waitUntilReady(auth, { parentWorkspaceId, name: pending.name }),
    ).catch((err: unknown) => {
      throw notReadyError(err, pending.name, flags, false, retryCommand(args));
    });
  }
  /** Flags this run accepted and could not act on, for the `--json` reader who never sees the warning. */
  const notApplied: string[] = [];

  if (target === null) {
    // A new environment is replaced and seeded whatever the flags, so a
    // `--keep-data` run reaches the same refusal a plain one did at the top —
    // before an environment is created for a publish that cannot land.
    refuseStaticHostAReplaceClears(args, true);
    const { docTokenRefusalIfReplaced } = await import("./cli.js");
    const docs = docTokenRefusalIfReplaced(KEEP_DATA_REPLACES[stored !== undefined ? "recreated" : "new"]);
    if (docs !== undefined) throw new Error(docs);
    // The display name this project already gave its environment carries over
    // to the one that replaces it: recreating after an expiry or a delete is
    // the same environment to whoever reads the dashboard. `--name` wins.
    const recorded = stored?.display !== undefined && stored.display !== stored.name ? stored.display : undefined;
    const display = args.name ?? recorded ?? deriveDisplay(bundle, dir, source);
    step(`Deploying ${ctx.shownSource ?? source} → new ephemeral "${display}"`);
    discloseWriteTarget(ephemeralParent(auth));
    // Why `--keep-data` keeps nothing, before the create and its readiness
    // wait — said after them, it read as the outcome of the wait.
    announceArm(
      selectDeployArm({ keepData: args.keepData, reset: args.reset, created: true, hadRecord: stored !== undefined, priorFilled: undefined, url: "" }),
      "ephemeral",
      false,
      content.length > 0,
    );
    // A signal from here on reports the create as sent, with the read that
    // settles it, rather than "Cancelled." over an environment that may exist.
    const machine = isMachineOutput(args);
    const listCommand = `xanosdk ephemeral list${flags}${machine ? " --json" : ""}`;
    const creating =
      activeOperation() === undefined
        ? registerOperation({
            machine,
            resolveWith: listCommand,
            what: `the create of ephemeral "${display}"`,
            snapshot: () => ({ ok: false, outcome: "unknown", ephemeral: { display }, resolveWith: listCommand }),
          })
        : undefined;
    creating?.markWriteSent();
    const fresh = await createEphemeral(auth, {
      parentWorkspaceId,
      display,
      expiresHours: args.expiresHours,
    }).finally(() => creating?.clear()).catch(async (err: unknown) => {
      if (isEphemeralDisabled(err)) throw ephemeralDisabledError(source);
      // "Invalid workspace" for a credential pinned to one it cannot see (a
      // wrong `XANO_WORKSPACE_ID`): the setting to fix and the ids that work.
      if ((err as { status?: unknown }).status === 404) {
        const { refuseUnreachableWorkspace } = await import("./workspace-binding.js");
        await refuseUnreachableWorkspace(auth);
      }
      throw unknownCreateOutcome(err, display, flags, retryCommand(args, { creates: true }));
    });
    // Recorded the moment it exists, BEFORE the readiness wait: a wait that
    // fails otherwise orphaned it — nothing named it, and the next deploy
    // created another. The record is rewritten in full below.
    try {
      setEnvironment(dir, auth, {
        name: fresh.name,
        display: fresh.display ?? display,
        url: fresh.url ?? "",
        expires_at: fresh.expiresAt,
        ...(auth.profile !== undefined && credentialFileOf(args) !== undefined ? { credential_file: credentialFileOf(args)! } : {}),
      });
    } catch (err) {
      // Nothing local tracks it now: the line names it and its delete.
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${reason}\n${createdButFailedNote(fresh.name, false, args, false, { untracked: true })}`);
    }
    // Recorded: a deploy started now finds it and deploys onto it. An
    // interrupt from here on says it exists, and what it holds.
    noteLanded({
      said: `Created ephemeral ${fresh.name} (tracked in .xano/ephemeral.json).`,
      ifCancelled: createdButFailedNote(fresh.name, false, args),
      fields: { ephemeral: { name: fresh.name, display: fresh.display ?? display }, created: true },
    });
    createGuard.release();
    target = await withSpinner(`Waiting for ${fresh.name} to become ready…`, () =>
      waitUntilReady(auth, { parentWorkspaceId, name: fresh.name }),
    ).catch((err: unknown) => {
      throw notReadyError(err, fresh.name, flags, true, retryCommand(args));
    });
  }

  const baseUrl = target.url;
  if (baseUrl === undefined) {
    const retry = retryCommand(args);
    throw new Error(`Ephemeral "${target.name}" has no base URL yet — try \`${retry.command}\` again.${withheldNote(retry.withheld)}`);
  }

  // `--name` on a refresh renames the ephemeral — a write, so a merge makes it
  // only once its refusals pass, and a replace only once its import landed.
  // Resolves to the new display name when it renamed, for the caller to carry
  // into `target` (a closure assigning it would undo its narrowing).
  const renaming = { name: target.name, display: target.display };
  const renameIfAsked = async (): Promise<string | undefined> => {
    const display = args.name;
    if (display === undefined || display === renaming.display) return undefined;
    await describeWrite(
      { what: `the rename of ephemeral "${renaming.name}"`, resolveWith: `xanosdk ephemeral get ${shellQuote(renaming.name)}${flags}` },
      () => renameEphemeral(auth, { parentWorkspaceId, name: renaming.name, display }),
    );
    // Only the display name changed; the tracked record keeps everything
    // else it already knew rather than trusting the update's response shape.
    const rec = getEnvironment(readEphemeralState(dir), auth);
    if (rec !== undefined && rec.name === renaming.name) setEnvironment(dir, auth, { ...rec, display });
    detail(`Renamed to "${display}".`);
    return display;
  };
  let renamedTo: string | undefined;
  const arm = selectDeployArm({
    keepData: args.keepData,
    reset: args.reset,
    created,
    hadRecord: stored !== undefined,
    priorFilled: stored?.filled,
    url: baseUrl,
  });
  await refuseEnvClearedByFallbackReplace(arm);
  if (!created) {
    step(
      `Deploying ${ctx.shownSource ?? source} → ${namedEphemeral(target)} (refresh, ${arm.arm === "merge" ? "keeping data" : "full replace"})`,
    );
    discloseWriteTarget(ephemeralParent(auth));
    await gateEntrySwap(args, namedEphemeral(target), stored?.entry, ctx.entry, arm.arm);
    // Before any write: a replace deletes the named host, and a merge needs it
    // to exist already.
    if (arm.arm === "replace") refuseStaticHostAReplaceClears(args, true);
    else await assertStaticHostExists(args, auth, { baseUrl, workspaceId: 1 });
    // A replace clears what another source landed here as surely as a merge
    // deletes it — asked before any write.
    if (arm.arm === "replace") {
      const { gateForeignReplace } = await import("./keep-data-merge.js");
      const { allowForeignDeletes, confirm } = await mergeGuards(args, undefined);
      await gateForeignReplace({
        auth,
        baseUrl,
        workspaceId: 1,
        label: namedEphemeral(target),
        bundle,
        kind: "ephemeral",
        rerun: rerunOf(args),
        ...(allowForeignDeletes === undefined ? {} : { allowForeignDeletes }),
        ...(confirm === undefined ? {} : { confirm }),
        landedGuids: new Set(
          Object.values(ephemeralLandedOn(dir, ephemeralLandingKey(auth.instance, target.name)) ?? {}).map((e) => e.guid),
        ),
      });
    }
    // Both flags are inputs to the CREATE, which a refresh never makes. The
    // name can still be carried by the tenant update (after the import, below);
    // the lifetime cannot — nothing writes an existing ephemeral's expiry — so
    // that one is said rather than dropped.
    if (args.expiresHours !== undefined) {
      notApplied.push("--expires-hours");
      warn(
        `--expires-hours ${args.expiresHours} was not applied: ${target.name} already exists, and an ` +
          `ephemeral's lifetime is set only when it is created` +
          (target.expiresAt !== undefined ? ` (this one expires ${String(target.expiresAt)})` : "") +
          `. To start a new one with that lifetime, run \`xanosdk ephemeral delete ${target.name}${contextFlags(args)}${offTerminalYes()}\` ` +
          `and deploy again.`,
        "ephemeral.expires-not-applied",
      );
    }
  }
  // A created one was announced before its create.
  if (!created) announceArm(
    arm,
    "ephemeral",
    arm.arm === "replace" && arm.skipped === "never-filled" &&
      Object.keys(ephemeralLandedOn(dir, ephemeralLandingKey(auth.instance, target.name)) ?? {}).length > 0,
    content.length > 0,
  );

  // Persist BEFORE import so an import failure still leaves a pointer the next
  // deploy can refresh rather than leaking a fresh tenant. The completed-import
  // marker rides along on EITHER arm, whenever it vouches for the URL serving
  // now: the import is applied in one transaction, so one that fails — refused,
  // or its answer lost — leaves the environment holding either its last good
  // state or this deploy's, never a half-emptied one. Dropping it here is what
  // turned a refused replace into a `--keep-data` run that replaced the rows it
  // was asked to keep. A replace that completes re-stamps it below.
  // The frontend URL an earlier `--static` publish left on THIS environment —
  // none on a new one. Carried forward on either arm: a merge leaves hosting
  // standing, and after a replace (which clears it) the record is what lets the
  // next `--static` publish say the URL changed.
  //
  // A replace clears the environment's static hosting — the engine's import
  // does, and no option keeps it — so whatever frontend serves here stops.
  // WHICH frontends is read from the platform: the record knows only what this
  // project published, and neither a frontend another project put here nor one
  // an earlier `deploy --to … --replace` already took down. The record answers
  // only when that read fails, and is then said to be unverified — and there
  // `static_down` keeps the warning to the deploy that did it.
  //
  // A URL the record doubts (an earlier replace took it down, or could not
  // check) is asked before the listing is believed: a refused replace leaves
  // its row listed over deleted content.
  const doubted = stored?.static_down === true || stored?.static_unchecked === true ? stored.static_url : undefined;
  const rechecked =
    !created && arm.arm === "replace"
      ? await recheckDoubtedFrontend(
          await readStaticTeardown(auth, { baseUrl, workspaceId: 1 }, stored?.static_down === true ? undefined : stored?.static_url),
          doubted,
        )
      : undefined;
  const teardownRead = rechecked?.read;
  const staticTeardown = teardownRead?.teardown;
  // The record follows what is live: a frontend serving now is the previous
  // URL the next publish compares against, and none serving means down.
  const previousStaticUrl = created
    ? undefined
    : (teardownRead?.live?.[0] ?? stored?.static_url);
  // Which frontend was SERVING just before this deploy — the only one whose
  // loss this deploy may take the blame for. The live read answers when it
  // succeeded (and a replace's empty answer means nothing was serving); else
  // the record does, unless it says an earlier replace already took it down.
  const servingBefore = created
    ? undefined
    : teardownRead?.live !== undefined
      ? teardownRead.live[0]
      : stored?.static_down === true
        ? undefined
        : stored?.static_url;
  // Before the import, the record says what stands NOW: down only when nothing
  // serves the recorded URL. A replace marks it down once its import LANDS
  // (below) — a refused one changed nothing, so it must not leave a stale
  // `static_down` behind for the next deploy's warning to trust.
  const staticDown = servingBefore === undefined;
  setEnvironment(dir, auth, {
    name: target.name,
    display: target.display ?? args.name ?? target.name,
    url: baseUrl,
    expires_at: target.expiresAt,
    ...(!created && stored?.filled !== undefined && stored.filled.url === baseUrl ? { filled: stored.filled } : {}),
    ...(previousStaticUrl !== undefined ? { static_url: previousStaticUrl } : {}),
    ...(previousStaticUrl !== undefined && staticDown ? { static_down: true } : {}),
    ...(previousStaticUrl !== undefined && rechecked?.unchecked === true ? { static_unchecked: true } : {}),
    // Which credential file reaches it, for the other-profile remedy.
    ...(auth.profile !== undefined && credentialFileOf(args) !== undefined ? { credential_file: credentialFileOf(args)! } : {}),
    // Which entry's backend stands here, for a remedy that redeploys it
    // (`env set`'s) and the entry-swap gate. Kept as it was until this import
    // lands — a refused one changed nothing — and rewritten once it has.
    ...(created
      ? ctx.entry !== undefined ? { entry: ctx.entry } : {}
      : stored?.entry !== undefined ? { entry: stored.entry } : {}),
  });
  // With `--static` the loss is a URL change, said once the new URL is known
  // (`noteStaticUrlChange`); without it, it is an outage, said now.
  if (teardownRead !== undefined && publishStatic === undefined) {
    warnStaticTeardown(teardownRead, namedEphemeral(target), {
      publishing: false,
      // The way to merge from THIS command line: `--keep-data` when it was not
      // passed, dropping `--reset` when that is what overrode it. When neither
      // can merge (nothing proves the environment holds an earlier deploy),
      // the only way back is a publish afterwards.
      keepHint: !args.keepData
        ? "pass `--keep-data` to merge, which leaves it serving"
        : arm.arm === "replace" && arm.skipped === "reset"
          ? "drop `--reset` to merge, which leaves it serving"
          : `publish it again afterwards with \`xanosdk publish <dir> --to ephemeral:${shellQuote(target.name)}${contextFlags(args)}\``,
    });
  }
  // And, right behind the record, that this project's bare commands now follow
  // an ephemeral. Same side of the import for the same reason: a failed import
  // leaves the environment standing, and the next bare `env set` or `test`
  // should still find it. Only this arm and the local one write it — a
  // `--to workspace|tenant` deploy is real and never becomes the default.
  recordDeployed(dir, "ephemeral");

  // The import is a full replace, and the clear it opens with takes this
  // environment's static hosting down with it — the site an earlier deploy
  // published stops serving the moment the import starts, and stays down when
  // the import then FAILS, which is what left a live URL answering
  // `default backend - 404`. So `--static` publishes here, after the
  // import, and after a failed one too: republishing is the only thing that
  // brings the host back, and a frontend serving the environment's previous
  // backend beats a dead URL.
  let importFailure: unknown;
  let merged: KeepDataMergeResult | undefined;
  try {
    if (arm.arm === "merge") {
      const { mergeKeepingData } = await import("./keep-data-merge.js");
      merged = await mergeKeepingData({
        auth,
        baseUrl,
        workspaceId: 1,
        label: namedEphemeral(target),
        bundle,
        content,
        files: archiveHostedFiles(archive),
        // An ephemeral has no `--dry-run` to preview again: what it holds is read.
        stateCheck: ephemeralStateCheck(namedEphemeral(target), target.name, flags),
        envSetTo: ` --to ${shellQuote(`ephemeral:${target.name}`)}${flags}`,
        kind: "ephemeral",
        rerun: rerunOf(args),
        // A rename here changes what the merge's own failure lines call it.
        beforeWrite: async () => {
          renamedTo = await renameIfAsked();
          if (renamedTo === undefined) return undefined;
          const label = namedEphemeral({ name: renaming.name, display: renamedTo });
          return { label, stateCheck: ephemeralStateCheck(label, renaming.name, flags) };
        },
        ...(await mergeGuards(args, ctx.lock, { bundle, compiled: ctx.compiled === true })),
        // Provenance for the removal lines: what this project landed here.
        landedGuids: new Set(
          Object.values(ephemeralLandedOn(process.cwd(), ephemeralLandingKey(auth.instance, target.name)) ?? {}).map(
            (e) => e.guid,
          ),
        ),
        storedColumns: storedColumnsOf(ephemeralLandedOn(process.cwd(), ephemeralLandingKey(auth.instance, target.name))),
      });
    } else {
      // `preserveGuids` because this import is a full replace and the archive's
      // identities are the contract: the bundle's guids are derived
      // (`md5(payloadKey:name)`, frozen in `xano.lock`), so preserving them makes
      // a redeploy UPDATE what the last one created instead of replacing it with
      // objects the project can no longer name. It is also what lets a guid read
      // off this environment — by `xanosdk tables`, or written into a frontend —
      // still resolve after the next deploy.
      const label = namedEphemeral(target);
      // Named by a signal while the replace is on the wire.
      const stateCheck = ephemeralStateCheck(label, target.name, flags);
      await withSpinner(IMPORTING_LABEL, () =>
        // An env's own internal workspace id is always 1.
        xanosdkImport(auth, {
          baseUrl,
          workspaceId: 1,
          label,
          archive,
          mode: "replace",
          dryRun: false,
          preserveGuids: true,
          stateCheck,
        }),
      );
    }
  } catch (err) {
    if (!lockCommitted) ctx.warnOrphansUncommitted?.();
    // A no to the merge's question: nothing was written, and nothing after
    // the import (a publish) runs — {@link runDeployCommand} says so, exit 0.
    if (err instanceof Error && err.name === "KeepDataDeclined") throw err;
    // Another import running on the instance: nothing was written, and the
    // same command goes through in a moment (exit 8). Said as itself, never
    // with a replace's aftermath.
    if (err instanceof XanoSdkImportRefusal && err.retryable) {
      const { importInProgressError } = await import("./keep-data-merge.js");
      const retry = retryCommand(args);
      throw importInProgressError(namedEphemeral(target), { command: retry.command, note: withheldNote(retry.withheld) }, err);
    }
    // An edited `--bundle` is refused for its signature: said with the remedy
    // `deploy --to` gives (E2E pass 20: a bare "Invalid workspace signature.").
    const { withSignatureHint } = await import("./release-command.js");
    importFailure = withSignatureHint(err, args.bundle);
  }
  // A merge renamed just before its write (a replace did above).
  if (arm.arm === "merge" && renamedTo !== undefined) target = { ...target, display: renamedTo };

  if (importFailure !== undefined) {
    const unknown = isUnknownImportOutcome(importFailure);
    // A connection that never opened sent nothing, so the clear a replace opens
    // with never ran: the frontend stands as it did, and its own error already
    // says the environment is untouched. Nothing to read back, and nothing to
    // republish — a republish would only move a frontend that still serves.
    const nothingSent = importFailure instanceof ImportNotSentError;
    const filledHere = stored?.filled !== undefined && !created && stored.filled.url === baseUrl;
    importFailure = noteKeptFilledMarker(importFailure, filledHere, args);
    // A tracked ephemeral never filled has no marker to speak of, and a new one
    // is named by `createdButFailedNote` below: this one still needs its rerun.
    if (!created && !filledHere) importFailure = noteReplaceRerun(importFailure, args);
    // The record keeps the frontend as it stood before the import (written
    // above) unless the read below finds it gone: a refused replace can still
    // have cleared static hosting, and an unknown one may or may not have —
    // which is read and said, not guessed.
    //
    // Either way the earlier "This replace takes the frontend at … down" warning
    // is answered: left standing, it read as the outcome of a replace that never
    // happened. It is said IN the error, so `--json` carries it.
    const warnedDown =
      staticTeardown !== undefined && staticTeardown.urls.length > 0
        ? staticTeardown.urls
        : servingBefore !== undefined
          ? [servingBefore]
          : [];
    if (arm.arm === "replace" && !nothingSent && publishStatic === undefined && warnedDown.length > 0) {
      // Read again rather than inferred from the failure: the clear that opens
      // a replace runs before most of what can refuse it, so a REFUSED import
      // still took static hosting down (E2E pass 17: a 500 on an unknown field
      // type left the site at `default backend - 404`), while a conflict
      // refused in the pre-flight left it serving. And the URL itself is
      // asked, not only the listing: the refused replace rolls the host row
      // back while the deleted content stays deleted (E2E pass 18).
      const states = await withSpinner("Checking the frontend…", () =>
        readFrontendsAfterFailure(auth, { baseUrl, workspaceId: 1 }, warnedDown),
      );
      const note = staticAfterFailedReplace(warnedDown, states, {
        unknown,
        publish: `xanosdk publish <dir> --to ephemeral:${shellQuote(target.name)}${contextFlags(args)}`,
      });
      // What stands now: nothing serves the recorded URL, so the next run's
      // warning (when its live read fails) must not claim it serves.
      const rec = getEnvironment(readEphemeralState(dir), auth);
      if (rec?.static_url !== undefined && note.down.includes(rec.static_url)) {
        setEnvironment(dir, auth, { ...rec, static_down: true });
      } else if (rec?.static_url !== undefined && states[rec.static_url] === "unknown") {
        // Not asked is not serving: the next replace asks it before warning.
        setEnvironment(dir, auth, { ...rec, static_unchecked: true });
      }
      // In the error — refused or unknown alike — so the `--json` document
      // carries the frontend's state and the publish that brings it back.
      if (importFailure instanceof Error) importFailure.message = `${importFailure.message}\n${note.text}`;
      else warn(note.text, "static.teardown");
    }
    // Only a replace tears static hosting down; a merge leaves it serving, so
    // there is nothing to bring back.
    if (publishStatic !== undefined && arm.arm === "replace" && !nothingSent) {
      warn("The import failed — republishing the frontend so the static host keeps serving.", "static.republish");
      const republished = await publishStatic({
        baseUrl,
        label: namedEphemeral(target),
        name: target.name,
        republish: true,
      });
      // The record follows the frontend that now serves, as a landed publish's
      // does: left on the cleared URL, a next run whose listing read fails
      // would warn about — and report removed — a URL that already was.
      if (republished.url !== undefined) recordStaticUrl(dir, auth, republished.url);
      // A republish that failed too leaves whatever the replace's clear left:
      // read, as the no-`--static` branch reads it, so the note says what
      // serves and the record stops naming a URL that serves nothing.
      let frontends: { warned: readonly string[]; states: Record<string, FrontendAfterFailure> } | undefined;
      if (republished.url === undefined && warnedDown.length > 0) {
        const states = await withSpinner("Checking the frontend…", () =>
          readFrontendsAfterFailure(auth, { baseUrl, workspaceId: 1 }, warnedDown),
        );
        frontends = { warned: warnedDown, states };
        const rec = getEnvironment(readEphemeralState(dir), auth);
        if (rec?.static_url !== undefined && states[rec.static_url] === "down") {
          setEnvironment(dir, auth, { ...rec, static_down: true });
        } else if (rec?.static_url !== undefined && states[rec.static_url] === "unknown") {
          setEnvironment(dir, auth, { ...rec, static_unchecked: true });
        }
      }
      // In the error, as the no-`--static` branch's note is: a `--json` reader
      // sees only the document, and the republish moved the frontend's URL.
      const note = republishNote(republished, unknown, frontends);
      if (importFailure instanceof Error) importFailure.message = `${importFailure.message}\n${note}`;
      else warn(note, "static.republish");
    }
    // A failed FIRST deploy still made an environment, and this project now
    // tracks it: said, with both ways on, so it is not found later as a
    // mystery (E2E pass 23).
    // Explained first, so the note's way on follows what failed.
    importFailure = explainDuplicateArchiveGuid(importFailure, args.file, contextFlags(args));
    if (created && importFailure instanceof Error) {
      const landedUnresolved = importFailure instanceof HostedFilesUnresolvedError && importFailure.applied;
      // A fetched source refused for a duplicate fails the same way on every redeploy.
      const futile = isFetchedDuplicateGuid(importFailure, args.file);
      importFailure.message += `\n${createdButFailedNote(target.name, unknown, args, landedUnresolved, { futile })}`;
    }
    throw importFailure;
  }
  // The lock, once the import landed — outside the try, so a lock that cannot
  // be written is not reported as a failed import. What a `--keep-data` merge
  // deleted is what a `--prune` deletes: its entries are not orphans to ask
  // "renamed? / deleted?" about, and the landing record drops them.
  const removedEntries = keepDataRemovedEntries(merged, ctx.lock);
  if (ctx.removedOut !== undefined && Object.keys(removedEntries).length > 0) ctx.removedOut.removed = removedEntries;
  if (ctx.removedOut !== undefined && merged?.storedColumns !== undefined) ctx.removedOut.storedColumns = merged.storedColumns;
  if (ctx.removedOut !== undefined && merged !== undefined && merged.removedGuids.length > 0) ctx.removedOut.removedGuids = merged.removedGuids;
  commitLock(Object.keys(removedEntries).length > 0 ? new Set(Object.keys(removedEntries)) : undefined);
  // Only now: the marker vouches for rows that landed.
  // The release it now runs, when this landed one: the server records none on
  // an ephemeral an archive was imported into, and `release delete` asks.
  const landedRelease = /^release:(.+)$/.exec(ctx.compiled === true ? "" : (args.file ?? ""))?.[1];
  markEnvironmentFilled(dir, auth, baseUrl, {
    ...(landedRelease === undefined ? {} : { release: landedRelease }),
    ...(ctx.entry === undefined ? {} : { entry: ctx.entry }),
  });
  // And only now is the frontend down: a replace that LANDED cleared static
  // hosting. A publish below records the new URL, which clears this again.
  if (arm.arm === "replace" && previousStaticUrl !== undefined) {
    const landed = getEnvironment(readEphemeralState(dir), auth);
    if (landed !== undefined) setEnvironment(dir, auth, { ...landed, static_down: true });
  }
  // An interrupt from here on — the rename, the static publish — says the
  // deploy landed before it names what it cut off.
  const noteDeployed = (landedOn: Pick<EphemeralSummary, "name" | "display">): void =>
    noteLanded({
      said: `Deployed ${namedEphemeral(landedOn)} (${arm.arm === "merge" ? "keeping its data" : "full replace"}).`,
      fields: { ephemeral: { name: landedOn.name, display: landedOn.display }, url: baseUrl, created },
    });
  noteDeployed(target);
  // A replace renames once its import landed, so a refused one leaves the name
  // as it was. The deploy has landed by now: a failed rename is said, not thrown.
  if (arm.arm === "replace" && !created) {
    try {
      const renamed = await renameIfAsked();
      if (renamed !== undefined) target = { ...target, display: renamed };
      noteDeployed(target);
    } catch (err) {
      const reconciled = await reconcileRename(err, auth, target.name, args.name ?? "");
      if (reconciled.renamed) {
        const rec = getEnvironment(readEphemeralState(dir), auth);
        if (rec !== undefined && rec.name === target.name) setEnvironment(dir, auth, { ...rec, display: args.name! });
        target = { ...target, display: args.name! };
        detail(`Renamed to "${args.name!}" (its answer was lost; read back from the ephemeral).`);
      } else {
        const retry = retryCommand(args);
        // Its own "may or may not have taken effect" is what the sentence after it settles.
        const reason = (err instanceof Error ? err.message : String(err)).replace(SENT_AFTERMATH, "").trim().replace(/[.\s]+$/, "");
        const state =
          reconciled.unknown
            ? `Whether it took effect is unknown — \`xanosdk ephemeral get ${target.name}${contextFlags(args)}\` shows its name; ` +
              `if it is not "${args.name ?? ""}", \`${retry.command}\``
            : `Its name is unchanged; \`${retry.command}\``;
        warn(
          `The deploy landed, but renaming ${target.name} to "${args.name ?? ""}" failed: ${reason}. ` +
            `${state} deploys again and renames it.${withheldNote(retry.withheld)}`,
          "ephemeral.rename-failed",
        );
      }
    }
  }

  const urlChanged = created || (stored !== undefined && stored.url !== baseUrl);
  if (urlChanged) {
    success(`E${namedEphemeral(target).slice(1)} deployed${elapsedSuffix(startedAt)}`);
    info("New ephemeral URL:");
    link(baseUrl);
  } else {
    const kept = arm.arm === "merge" ? ", keeping its data" : "";
    success(`Refreshed ${namedEphemeral(target)}${kept}${urlsNote(merged)}${elapsedSuffix(startedAt)}`);
    link(baseUrl);
  }
  detail(`Expires ${formatExpiration(target.expiresAt)}`);
  // `target.name` (the tenant handle, e.g. `ewap-8wz9-9e13`) — NOT the display —
  // is what `ephemeral get/delete/export` and `impersonate ephemeral:<name>` take, so spell out the
  // handle to use. The builder line is the one people ask for next: a deployed
  // env is otherwise a URL with no way in.
  // With this run's credential flags: after `deploy --config live.json` a
  // bare hint reads the machine's default account, not this ephemeral's.
  detail(`Manage with \`xanosdk ephemeral get ${target.name}${contextFlags(args)}\``);
  detail(`Open the builder with \`xanosdk impersonate ephemeral:${target.name}${contextFlags(args)}\``);

  // Ahead of the microservice wait, which can run for minutes: every second
  // between the import and this publish is a second the frontend is dark.
  const published = await publishStatic?.({ baseUrl, label: namedEphemeral(target), name: target.name });
  if (published?.url !== undefined) {
    noteStaticUrlChange(
      servingBefore,
      published.url,
      arm,
      servingBefore === undefined && !created && stored?.static_down === true ? stored.static_url : undefined,
    );
    recordStaticUrl(dir, auth, published.url);
  }
  // The pre-import notice is skipped under `--static` — the new frontend was
  // going to replace the old one — so when it did not, what the replace took
  // down is said here, or the reader learns it from a dead bookmark.
  if (published?.error !== undefined) noteStaticTakenDown(staticTeardown, published.completed === "unknown");

  let microservicesError: MicroservicesError | undefined;
  const microservices = await verifyMicroservices(auth, baseUrl, {
    ...microserviceCheck(args),
    name: target.name,
    flags: contextFlags(args),
    onReadError: (e) => (microservicesError = e),
  });
  // Last, so it costs a created environment one read and nothing before it.
  if (created) await warnSameDisplayName(auth, parentWorkspaceId, target, stored?.name, contextFlags(args));

  return {
    kind: "ephemeral",
    destination: backendDestinationPayload(auth, {
      kind: "ephemeral",
      name: target.name,
      url: baseUrl,
      ...(target.display !== undefined && target.display !== target.name ? { display: target.display } : {}),
    }),
    profile: auth.profile ?? null,
    url: baseUrl,
    ephemeral: { name: target.name, display: target.display, expiresAt: target.expiresAt },
    created,
    ...dataFields(arm),
    ...mergeLossFields(merged),
    // Beside `--static` too: the new frontend may be at a new URL, and the one a
    // bookmark or a shared link holds is what this names.
    ...staticRemovedField(staticTeardown, published?.url),
    ...(notApplied.length > 0 ? { notApplied } : {}),
    ...(microservices ? { microservices } : {}),
    ...(microservicesError !== undefined ? { microservicesError } : {}),
  };
}

/** See {@link StaticPublishSummary.staticEnv}. */
export interface StaticEnvReport {
  injected: boolean;
  /** The config's keys, each served as `window.<key>`. */
  keys: string[];
  /** How many HTML documents took it. */
  documents: number;
  skipped?: string[];
  reason?: string;
}

/**
 * What a static publish reports: where it serves, which build it is, and
 * whether the edge was seen serving it.
 */
export interface StaticPublishSummary {
  url: string | undefined;
  /**
   * Whether the `window.*` config (`XANO_HOST` plus every `--static-env` key)
   * reached the build's HTML. `injected` is true when at least one document
   * took it; `skipped` names documents with no `<head>` to anchor to, which
   * serve their routes with the globals unset; `reason` is the sentence stderr
   * printed when any document went without. A `--json` reader sees only this.
   * Absent when there was no config to inject.
   */
  staticEnv?: StaticEnvReport;
  /**
   * The build's identity as the host stamps it on `X-Xano-Canonical`. Absent
   * when the build response carried none, which is also what skips `verified`.
   */
  canonical?: string;
  /** Absent when the check did not run (opted out, no URL, or no canonical). */
  verified?: boolean;
  /** The routing shape the build was declared with — inferred, or `--static-routing`. Absent when the upload failed. */
  routing?: "spa" | "multipage";
  /**
   * The build's server half (`.xano-ssr/`, from `@xano/sdk/sveltekit`): `uploaded`
   * where the target renders it (a Xano Engine), `omitted` where the target
   * serves files only. Absent when the build has none.
   */
  serverBundle?: "uploaded" | "omitted";
  /**
   * Present only when the upload FAILED after the backend landed — the reason,
   * as printed. `url` is then absent. A `--json` reader never sees the warning
   * on stderr, so without this a failed frontend was indistinguishable from
   * none having been asked for.
   */
  error?: string;
  /**
   * With `error`: the `publish` command that retries only the static step, as
   * stderr prints it — the backend that landed is not deployed again.
   */
  retry?: string;
  /**
   * With `error`: whether the frontend is up — `"no"` (nothing was sent, or it
   * was refused; exit 3) or `"unknown"` (the upload was sent and its answer
   * lost; exit 9 — the retry settles it). The operation documents' vocabulary.
   */
  completed?: "no" | "unknown";
}

/** Where a static frontend is uploaded: an env base URL + workspace id, with a display label. */
export interface StaticTarget {
  baseUrl: string;
  workspaceId: number;
  /** Human label for the progress line (e.g. `ephemeral e4f2`); falls back to `workspace #id`. */
  label: string | undefined;
  /**
   * The caller already printed the headline naming this publish (`publish`
   * leads with one, above its disclosure and prompt), so the step line here
   * would say the same thing twice.
   */
  announced?: boolean;
}

/**
 * Archive `dir` and deploy it to a static host on the given target (env base URL
 * + workspace id). `deploy` points this at the ephemeral itself or the parent
 * workspace per destination; `release` reuses it for the instance workspace.
 */
export async function deployStaticTo(
  dir: string,
  auth: Pick<ResolvedAuth, "access_token">,
  target: StaticTarget,
  env: Record<string, string>,
  explicit: boolean,
  host?: string,
  skipLiveness?: boolean,
  routing?: "spa" | "multipage",
  /**
   * Where `dir` came from, for a refusal: `"--static"` when it is that flag's
   * value. Omitted (`publish <dir>`), the refusal names the directory alone.
   */
  dirLabel?: string,
  /**
   * `serverRendered`: the target runs a build's server half (a Xano Engine).
   * `rerun`: the publish that settles an interrupted upload — a publish
   * replaces the host's build, so running it again is safe either way.
   */
  opts: { serverRendered?: boolean; rerun?: string } = {},
): Promise<StaticPublishSummary> {
  const { deployStaticHost } = await import("../deploy/static-host.js");

  const where = target.label && target.label !== "" ? target.label : `workspace #${target.workspaceId}`;
  if (target.announced !== true) step(`Deploying static frontend ${dir} → ${where}${host ? ` (host: ${host})` : ""}`);
  const sh = await describeWrite(
    {
      what: `the static publish to ${where}`,
      check:
        opts.rerun === undefined
          ? `Open ${where}'s frontend to see which build it serves before retrying.`
          : `A publish replaces the host's build, so running it again settles it either way: \`${opts.rerun}\`.`,
    },
    () =>
      deployStaticHost({
        host,
        dir,
        workspaceId: target.workspaceId,
        baseUrl: target.baseUrl,
        accessToken: auth.access_token,
        env,
        routing,
        ...(dirLabel === undefined ? {} : { label: dirLabel }),
        ...(opts.serverRendered === true ? { serverRendered: true } : {}),
      }),
  );
  // A server half the target does not run was left out of the upload: say so,
  // since the site's dynamic routes are then served by the fallback page alone.
  if (sh.serverBundle === "omitted") {
    detail(
      "Server half (.xano-ssr/) not uploaded: this host serves files only. `xanosdk deploy --local --static` renders it.",
    );
  }

  // Files the host will not serve: a path that silently falls back to
  // index.html breaks whatever fetches it (an app-link check reads
  // `.well-known/`), so each is named.
  if (sh.hiddenUnserved !== undefined) {
    const shown = sh.hiddenUnserved.slice(0, 5).join(", ") + (sh.hiddenUnserved.length > 5 ? `, and ${sh.hiddenUnserved.length - 5} more` : "");
    const wellKnown = sh.hiddenUnserved.some((p) => p.split("/").includes(".well-known"));
    warn(
      `Not served: ${shown} — the static host serves no path with a dot segment, so ` +
        `${sh.hiddenUnserved.length === 1 ? "it answers" : "they answer"} with the fallback page` +
        `${wellKnown ? " (a `.well-known/` file such as assetlinks.json or apple-app-site-association cannot be hosted here; serve it from the backend or another host)" : ""}.`,
      "static.hidden-unserved",
    );
  }
  if (sh.skippedLinks !== undefined) {
    const named = sh.skippedLinks.map((l) => `${l.path} (${l.reason === "outside" ? "points outside the build" : "points to nothing"})`).join(", ");
    warn(`Not uploaded: ${named}. A symlink is followed only to a file or directory inside the build; copy the target in instead.`, "static.link-skipped");
  }

  // Say which shape was declared. It decides whether a route resolves to its own
  // document or to the app shell, and an inference the author disagrees with is
  // otherwise invisible until a page renders the wrong content with a 200.
  detail(
    sh.routing === "multipage"
      ? "Routing: multipage — routes resolve to their own documents."
      : "Routing: spa — every path serves index.html.",
  );
  if (sh.routingSuspect === true) {
    const suspectPages = sh.routingSuspectPages !== undefined && sh.routingSuspectPages.length > 0 ? sh.routingSuspectPages : ["404.html"];
    warn(
      `Routing was inferred as multipage only because the build ships ${suspectPages.join(" and ")} beside index.html — ` +
        `the shape of a single-page app with its own ${suspectPages.length === 1 && suspectPages[0]!.toLowerCase() === "200.html" ? "fallback" : "not-found"} page. ` +
        `If a client router serves its routes, its deep links never reach index.html.`,
      "static.routing-inferred-multipage",
      ["Pass `--static-routing spa` to serve index.html for every route the build has no file for."],
    );
  }

  const globals = Object.keys(env).map((k) => `window.${k}`);
  let staticEnv: StaticEnvReport | undefined;
  if (globals.length > 0) {
    staticEnv = { injected: sh.envInjected, keys: Object.keys(env), documents: sh.envDocuments };
    // Say how many documents took the config, not just that injection happened:
    // a prerendered build serves one document per route, and a route that missed
    // it runs with no backend and renders anyway.
    const docs = sh.envDocuments === 1 ? "1 document" : `${sh.envDocuments} documents`;
    if (sh.envInjected) success(`Config injected into ${docs}: ${globals.join(", ")}`);
    // A document without a <head> serves its route with the globals unset, which
    // is invisible from the outside — name the files rather than letting the
    // count quietly disagree with the bundle. When that is EVERY document, this
    // is the only line: "no HTML document" beside it would contradict it.
    if (sh.envSkipped.length > 0) {
      const reason = `Config not injected into ${sh.envSkipped.join(", ")} — no <head> to anchor to; those routes run with ${globals.join(", ")} unset.`;
      staticEnv = { ...staticEnv, skipped: [...sh.envSkipped], reason };
      warn(reason, "static-env.not-injected");
    } else if (!sh.envInjected) {
      const reason = explicit
        ? `Config not injected — the build has no HTML document. ${globals.join(", ")} unset.`
        : `No HTML document to inject window.XANO_HOST into — skipped.`;
      staticEnv = { ...staticEnv, reason };
      if (explicit) warn(reason, "static-env.not-injected");
      else detail(reason);
    }
  }

  success("Static host deployed");
  if (sh.url) link(sh.url);

  // Confirm the edge is serving THIS build before calling it done. The build POST
  // 200 only means the archive was ingested — a cold pod can still 503 and a
  // redeploy can route the previous build for a window. Poll `X-Xano-Canonical`
  // until it matches this build's canonical. Skipped (and reported as before)
  // when opted out, when there's no URL to poll, or when the response carried no
  // canonical to compare against (older engine / unexpected shape).
  const published: StaticPublishSummary = {
    url: sh.url,
    routing: sh.routing,
    ...(staticEnv !== undefined ? { staticEnv } : {}),
    ...(sh.canonical !== undefined ? { canonical: sh.canonical } : {}),
    ...(sh.serverBundle !== undefined ? { serverBundle: sh.serverBundle } : {}),
  };
  if (skipLiveness || sh.url === undefined || sh.canonical === undefined) {
    return published;
  }
  const { verifyRollout } = await import("../deploy/verify-rollout.js");
  // Destructured out of `sh` because a closure doesn't keep the narrowing the
  // early return above established on `sh.url`/`sh.canonical`.
  const { url, canonical } = sh;
  const { live } = await withSpinner("Verifying the frontend is live…", () => verifyRollout(url, canonical));
  if (live) {
    success("Frontend is live");
  } else {
    // Not a failure: the build uploaded fine, the edge just hasn't confirmed it
    // in time (a slow cold pod usually serves moments later). Warn, record it in
    // the summary, and leave the exit code untouched.
    warn(
      "Could not confirm the frontend is live within the wait window — the build uploaded and should come online shortly.",
      "static.unconfirmed-live",
      [`Re-check by opening ${sh.url}, or skip this wait next time with --skip-liveness.`],
    );
  }
  return { ...published, verified: live };
}

/**
 * Tell the compile's refusals which credential this run acts as — lazily, because
 * this module only type-imports from `cli.js` and a value import would close a
 * cycle.
 */
async function noteRunScopeFor(auth: ResolvedAuth): Promise<void> {
  const { noteRunScope } = await import("./cli.js");
  noteRunScope(auth);
}

/** Moved beside the rest of the static step; re-exported for its importers. */
export { unknownStaticOutcome };
