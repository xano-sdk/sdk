/**
 * The one step between "a local deploy was asked for" and "there is an engine to
 * import into": make sure a verified binary is on this machine, reconcile what
 * this project recorded against what is actually serving, reuse or start, and
 * write the record.
 *
 * Its own module rather than another branch inside `deploy-command.ts` because
 * the decision it makes is not about deploying at all — it is about process
 * lifecycle — and because the reuse-or-start reconciliation is the part worth
 * testing without a compile in front of it.
 *
 * **The record is written here, before returning.** This deploy is ordered by
 * what the import destroys: the import is the expensive, non-atomic step, so
 * the record has to exist before it starts. Writing it at the end of this
 * function makes that ordering structural — a caller cannot import before it
 * returns — rather than a line someone has to keep above another line.
 *
 * **The enumeration is the oracle; the record is a hint.** A record says which
 * name this project used and where it served last time. Whether anything is
 * still listening is only ever answered by asking the engine what it is running.
 *
 * **Reuse needs the SAME engine, and the digest is its identity.** A live engine
 * is reused only when its record names the digest of the binary just acquired.
 * A version string is not enough — an override build and a release can report
 * the same one — and the engine's own listing carries none. A different digest,
 * a record with no digest, or a live engine under the derived name with no
 * record at all is replaced: stopped by name through the engine's own verb
 * (never a pid), then the acquired binary is started fresh. A fresh start holds
 * no rows, so it is recorded without the completed-import marker and a
 * `--keep-data` deploy seeds it.
 *
 * **The same engine also means the same telemetry choice.** The engine reads
 * `DO_NOT_TRACK`, `CI` and the `XANO_TELEMETRY*` variables once, at boot, so an
 * engine an opted-in launcher started would keep reporting for a later caller
 * who opted out. The record keeps what each engine was started with. When
 * neither that nor the caller's own could make an engine report (see
 * `engineMayReport`), the engine is reused whatever else differs: restarting
 * it would drop its rows and change nothing. Otherwise any difference in the
 * five variables takes the same replace, as does a snapshot the record holds
 * but cannot be read. A record with no snapshot (an older SDK wrote it) is
 * reused only by a caller who neither may report nor opts out.
 *
 * Node-only, reached by a lazy import from the command layer.
 */
import { realpathSync, rmSync } from "node:fs";
import { sep } from "node:path";
import { acquireEngine, type AcquiredEngine, type EngineFetch } from "./local-engine-release.js";
import { readEngineEntry, RELEASE_VERSION, type EngineCacheEntry } from "./local-engine-cache.js";
import { clampEngineAiTtl, engineAiTokenPath, ENGINE_AI_MAX_TTL_S, type EngineSourceSpec } from "./local-engine-config.js";
import type { AiBilling, AiOff, AiOutcome, EngineAiRequest } from "./local-engine-ai.js";
import { assertLoopbackUrl, type LocalEngine } from "./local-engine-handshake.js";
import {
  engineVersion as askEngineVersion,
  engineRunsUntilStopped,
  engineMayReport,
  engineTelemetryEnv,
  telemetryOptedOut,
  engineVersionToken,
  ENGINE_TELEMETRY_ENV,
  listEngines,
  resolveRecordedEngine,
  startEngine,
  stopEngineNamed,
  stopOrphanedEngineProcesses,
  type EngineAiWiring,
  type EngineRun,
  type EngineSpawn,
} from "./local-engine-process.js";
import {
  engineNameForProject,
  getEngineRecord,
  setEngineRecord,
  type LocalEngineRecord,
} from "./local-engine-state.js";
import type { FilledMarker } from "./keep-data.js";
import { recordDeployed } from "./deployed-state.js";
import { PROJECT_DATA_DIR, projectDataDir, projectHasData } from "./local-data.js";
import { ImportHttpError } from "./import.js";
import { compareSemver, parseSemver } from "../emit/semver.js";

/**
 * Ask for the engine's Xano AI credential before it starts — see
 * `local-engine-ai.ts`. Absent, none is asked for; an engine started here
 * still gets the credential file's path, so a later deploy's credential
 * reaches it.
 */
export interface EngineAiOptions {
  billing: AiBilling;
  /** Overridden only by tests. */
  request?: (req: EngineAiRequest) => Promise<AiOutcome>;
}

/** What {@link ensureProjectEngine} needs: a project, a source, and the seams. */
export interface EnsureEngineOptions {
  /** The project directory. Keys the record and derives the engine's name. */
  dir: string;
  /**
   * Where the engine comes from, already decided by `resolveEngineSource` — an
   * override the flag named, or a release (a pinned version, or latest). Taken
   * resolved rather than re-derived here so the caller owns the precedence.
   */
  source: EngineSourceSpec;
  env?: NodeJS.ProcessEnv;
  /** The command to run again, as typed, named by a failure getting the engine whose remedy is a rerun. */
  rerun?: string;
  /** What that rerun leaves out (withheld `--env-var` values), said after it. */
  rerunNote?: string;
  /** Overridden only by tests, which drive these without a real binary. */
  fetch?: EngineFetch;
  spawn?: EngineSpawn;
  run?: EngineRun;
  /**
   * Stop what crashed engines left running before a fresh start, returning the
   * pids stopped. Defaults to the real sweep — except where a test replaced
   * {@link spawn}, and so the machine, without replacing this.
   */
  sweepOrphans?: () => readonly number[];
  /**
   * Whether the record this writes carries the prior completed-import marker
   * forward. Asked once the serving engine is known, because the answer turns
   * on it — the deploy carries a marker stamped with the URL serving now,
   * since the import is one transaction and a failed one leaves the engine
   * holding its last good state; a completed import re-stamps it. Absent means
   * drop.
   */
  carryFilled?: (ctx: {
    reused: boolean;
    hadRecord: boolean;
    priorFilled: FilledMarker | undefined;
    url: string;
  }) => boolean;
  /**
   * Told the engine this run resolved to, the moment it is acquired and
   * verified — before anything running is stopped or started. The caller's
   * hook for writes that must follow a successful acquisition and nothing less
   * (moving a project's pin): a failed download never reaches it.
   */
  onAcquired?: (acquired: AcquiredEngine) => void;
  /** Told the version a release download put on this machine; never for a cached engine (see `acquireEngine`). */
  onDownloaded?: (version: string) => void;
  /** The engine's Xano AI credential, asked for before any start. */
  ai?: EngineAiOptions;
}

/** A live engine this run stopped because it was not the engine it resolved to. */
export interface ReplacedEngine {
  name: string;
  /** The version the stopped engine was recorded as, when it was recorded at all. */
  from: string | undefined;
  /** The version started in its place, when known. */
  to: string | undefined;
  /**
   * Set only when the binary was the same and the engine was restarted because
   * it was started with other telemetry variables than this run's: the names
   * that differ, or `"unknown"` when its record does not say (an unreadable
   * snapshot, or none for a caller who opts out or may report).
   */
  telemetry?: readonly string[] | "unknown";
  /**
   * Set only when the binary and the telemetry were the same and the engine was
   * restarted because the project's data changed under it: `"project"` when it
   * now runs on the project's own `xano/data` (it ran a throwaway database
   * before), `"throwaway"` when the project no longer has one.
   */
  data?: "project" | "throwaway";
  /** Whether the engine started in its place runs on the project's own `xano/data`. */
  onProjectData?: boolean;
}

/**
 * The line a deploy says when it replaced a live engine: what changed, and that
 * the new engine starts empty. A replace is a binary change unless
 * {@link ReplacedEngine.telemetry} says otherwise.
 */
export function replacedEngineLine(replaced: ReplacedEngine): string {
  const empty =
    replaced.onProjectData === true
      ? `It runs on this project's own data in ${PROJECT_DATA_DIR}, which a restart keeps.`
      : "It starts empty, so this deploy seeds it.";
  if (replaced.data === "project") {
    return `Restarted Xano Engine ${replaced.name} on this project's own data in ${PROJECT_DATA_DIR} (it ran a throwaway database before).`;
  }
  if (replaced.data === "throwaway") {
    return `Restarted Xano Engine ${replaced.name} on a throwaway database: this project no longer has ${PROJECT_DATA_DIR}. ${empty}`;
  }
  if (replaced.telemetry === "unknown") {
    return (
      `Restarted Xano Engine ${replaced.name}: its record does not say which telemetry settings it was started ` +
      `with, so they may differ from this deploy's. ${empty}`
    );
  }
  if (replaced.telemetry !== undefined) {
    return (
      `Restarted Xano Engine ${replaced.name}: it was started with other telemetry settings ` +
      `(${replaced.telemetry.join(", ")}) than this deploy's. ${empty}`
    );
  }
  return (
    `Replaced Xano Engine ${replaced.name} (${replaced.from ?? "an unrecorded version"} → ` +
    `${replaced.to ?? "the resolved engine"}). ${empty}`
  );
}

/** The engine a deploy is about to import into, and how it got there. */
export interface ProjectEngine {
  engine: LocalEngine;
  /** True when an engine was already serving and this deploy joined it. */
  reused: boolean;
  /**
   * Where this project's engine served before this run, when anything was
   * recorded. The deploy reports whether the URL changed against it — a
   * restarted engine binds a fresh ephemeral port, so "same engine" and "same
   * URL" are different questions.
   */
  previousUrl: string | undefined;
  /** The cached engine that is serving, for the record and for later reporting. */
  entry: EngineCacheEntry;
  /** The release version that engine is (`v0.1.5`); absent when an override is serving. */
  version: string | undefined;
  /**
   * The version to show for the serving engine: the release version, or an
   * override binary's own `version` output. Absent only when an override
   * could not report one.
   */
  engineVersion: string | undefined;
  /** Set when a live engine of another digest was stopped and this one started in its place. */
  replaced?: ReplacedEngine;
  /**
   * Processes a crashed engine left running, stopped before this start — no
   * listing shows them, so the deploy says so. Absent when there were none.
   */
  sweptOrphans?: readonly number[];
  /** Whether this project had an engine recorded before this run. */
  hadRecord: boolean;
  /**
   * The completed-import marker the record held BEFORE this run rewrote it.
   * Read first because the rewrite replaces the record wholesale — asked
   * afterwards, every engine would read as never filled.
   */
  priorFilled: FilledMarker | undefined;
  /** Whether Xano AI is on for this engine, when {@link EnsureEngineOptions.ai} asked. */
  ai?: AiOutcome;
  /**
   * The project's own data directory (`xano/data`, absolute) when the engine
   * runs on it — a persistent engine, whose rows a deploy must never replace.
   * Absent for a throwaway engine.
   */
  dataDir?: string;
}

/**
 * The engine this project deploys to: reused if one is already serving, freshly
 * started otherwise — recorded either way, before this returns.
 *
 * The name is DERIVED from the project path rather than read off the record, so
 * a project whose record was lost still asks for the engine it started before
 * instead of standing a second one up beside it.
 */
export async function ensureProjectEngine(opts: EnsureEngineOptions): Promise<ProjectEngine> {
  try {
    return await ensureProjectEngineUnnoted(opts);
  } catch (err) {
    throw withDeployFallbackNote(err);
  }
}

/**
 * The line every failure to get an engine serving ends with — on a deploy, and
 * only there. The same failures reached from a `local` verb (a bad
 * `cache clear --version`, a `stop` with nothing cached) are about the engine
 * the reader asked for by name, and pointing at the ephemeral arm there reads
 * as an unrelated aside.
 */
export const DEPLOY_FALLBACK_NOTE = "Meanwhile `xanosdk deploy --ephemeral` still deploys to an ephemeral.";

/** `err` with {@link DEPLOY_FALLBACK_NOTE} as its last line; its class, and so its exit code, kept. */
function withDeployFallbackNote(err: unknown): unknown {
  if (!(err instanceof Error) || err.message.includes(DEPLOY_FALLBACK_NOTE)) return err;
  err.message = `${err.message.trimEnd()}\n${DEPLOY_FALLBACK_NOTE}`;
  return err;
}

async function ensureProjectEngineUnnoted(opts: EnsureEngineOptions): Promise<ProjectEngine> {
  const env = opts.env ?? process.env;
  // Before anything is enumerated: every later call runs the cached binary, and
  // there is nothing to enumerate WITH until there is one.
  const acquired = await acquireEngine({
    spec: opts.source,
    env,
    ...(opts.rerun === undefined ? {} : { rerun: opts.rerun }),
    ...(opts.rerunNote === undefined || opts.rerunNote === "" ? {} : { rerunNote: opts.rerunNote }),
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
    ...(opts.onDownloaded === undefined ? {} : { onDownloaded: opts.onDownloaded }),
  });
  const { entry, version } = acquired;
  opts.onAcquired?.(acquired);

  // A release's version comes from resolution; an override is asked, as
  // `local list` asks. Best-effort — it is for display, and an engine
  // that cannot say is still an engine.
  const shownVersion = version ?? overrideVersion(entry, env, opts.run);

  // The project's own data, when it has some: the engine then runs ON it,
  // persistent, rather than on a throwaway database (see `local-data.ts`).
  const dataDir = projectHasData(opts.dir) ? projectDataDir(opts.dir) : undefined;
  const { record, name, live, replaced } = reconcileLive(opts.dir, entry, shownVersion, env, opts.run, dataDir);

  // Before a fresh start: an engine killed outright left its helper processes
  // serving, holding their data and ports, and nothing lists them (E2E pass 26).
  const sweep = opts.sweepOrphans ?? (opts.spawn === undefined ? () => stopOrphanedEngineProcesses({ env }).stopped : undefined);
  const sweptOrphans = live === undefined && sweep !== undefined ? sweep() : [];

  // Before any start: the gateway URL is fixed when the engine boots, and the
  // answer is what names it.
  const ai = await engineAi(opts.ai, name, live === undefined ? undefined : { record }, aiTtlFor(live, shownVersion, dataDir), env);

  const engine =
    live ??
    (await startEngine({
      entry,
      name,
      env,
      ...(shownVersion === undefined ? {} : { version: shownVersion }),
      ...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
      ai: wiringFor(name, ai, env),
      ...(dataDir === undefined ? {} : { dataDir }),
    }));

  const reused = live !== undefined;
  const hadRecord = record !== undefined;
  const priorFilled = record?.filled;
  const carry = opts.carryFilled?.({ reused, hadRecord, priorFilled, url: engine.url }) === true;

  // The moment the engine is known to be serving, and before the
  // caller can send a byte at it. Written on the reuse arm too — that is what
  // repairs a record whose URL is stale or that was lost entirely. A replaced
  // engine is a fresh start, so `reused` is false and the marker is never
  // carried: the new process holds no rows to vouch for.
  // A started engine was given the credential file, and the gateway URL when the
  // answer named one; a reused one keeps what it was started with.
  const aiGatewayUrl = reused ? record?.aiGatewayUrl : ai?.gatewayUrl;
  // What the engine serving now was started with: a fresh start was just given
  // the caller's; a reused one keeps its own, which may differ where neither
  // could report, and stays unknown when its record had none.
  const telemetryEnv = reused ? record?.telemetryEnv : engineTelemetryEnv(env);
  writeRecord(opts.dir, engine, entry, shownVersion, reused && carry ? priorFilled : undefined, env, aiGatewayUrl, telemetryEnv, dataDir);
  // A DEPLOY to this engine, so the project's bare commands now follow it.
  // Here, beside the deploy's record write — never inside `writeRecord`, which
  // the `local update` restart also reaches: a restart is not a deploy,
  // and must not pull a project iterating on an ephemeral over to the engine.
  // Only for an engine this call started: a reused one is recorded by the
  // deploy once its import is sent, so a refused `--keep-data` preview leaves
  // the pointer as it was (E2E pass 27: it rewrote `deployedAt`).
  if (!reused) recordDeployed(opts.dir, "local");

  return {
    engine,
    reused,
    previousUrl: record?.url,
    entry,
    version,
    engineVersion: shownVersion,
    ...(replaced === undefined ? {} : { replaced }),
    ...(sweptOrphans.length === 0 ? {} : { sweptOrphans }),
    hadRecord,
    priorFilled,
    ...(ai === undefined ? {} : { ai }),
    ...(dataDir === undefined ? {} : { dataDir }),
  };
}

/**
 * The engine's Xano AI outcome, asked for when `opts` says to.
 *
 * A live engine this run reuses reads its gateway URL only from the environment
 * it booted with. One started without a URL (its record names none, or there is
 * no record) can never use a credential, so none is asked for and the outcome
 * says to restart it. One started with a URL other than the one the answer names
 * would call the wrong gateway, so an `on` answer becomes the same restart.
 */
async function engineAi(
  opts: EngineAiOptions | undefined,
  name: string,
  reuse: { record: LocalEngineRecord | undefined } | undefined,
  ttl: number,
  env: NodeJS.ProcessEnv,
): Promise<AiOutcome | undefined> {
  if (opts === undefined) return undefined;
  const booted = reuse?.record?.aiGatewayUrl;
  if (reuse !== undefined && booted === undefined) {
    return restartToEnable(name, opts.billing, "was started before it could take a Xano AI credential", env);
  }
  const request = opts.request ?? (await import("./local-engine-ai.js")).requestEngineAiCredential;
  const outcome = await request({ billing: opts.billing, engineName: name, ttl, env });
  if (reuse !== undefined && outcome.status === "on" && outcome.gatewayUrl !== undefined && outcome.gatewayUrl !== booted) {
    return restartToEnable(name, opts.billing, "was started with another Xano AI gateway than this sign-in uses", env);
  }
  return outcome;
}

/** The lifetime an engine started without `--ttl` may stop itself after: the engine's default hour. */
const ENGINE_DEFAULT_TTL_S = 3600;

/**
 * How long, in seconds, the Xano AI credential for this engine is worth: as
 * long as the engine runs, capped at the day the server issues at most.
 *
 * A live engine says when it stops (its listing's stop time), or runs until it
 * is stopped. A fresh one is started by this SDK, so its version says: one that
 * runs until stopped gets the day, and one of unknown version, which may stop
 * after its default hour, gets the hour.
 */
function aiTtlFor(live: LocalEngine | undefined, version: string | undefined, dataDir?: string): number {
  if (live !== undefined) {
    return live.expiresAt === undefined ? ENGINE_AI_MAX_TTL_S : clampEngineAiTtl((live.expiresAt - Date.now()) / 1000);
  }
  // A persistent engine has no lifetime at all, whatever its version.
  return dataDir !== undefined || engineRunsUntilStopped(version) ? ENGINE_AI_MAX_TTL_S : ENGINE_DEFAULT_TTL_S;
}

/**
 * The outcome for a live engine whose boot environment cannot use this
 * credential: `why` says how. Any credential file is removed, so an engine
 * reported off holds nothing it could still spend.
 */
function restartToEnable(name: string, billing: AiBilling, why: string, env: NodeJS.ProcessEnv): AiOff {
  rmSync(engineAiTokenPath(name, env), { force: true });
  return {
    status: "off",
    billing,
    reason: "restart-to-enable",
    message:
      `Xano AI is off for this engine: ${name} ${why}. ` +
      `Restart it to turn it on: \`xanosdk local stop ${name}\`, then deploy again.`,
  };
}

/** What a start passes the engine for Xano AI: always the credential file, and the gateway when known. */
function wiringFor(name: string, ai: AiOutcome | undefined, env: NodeJS.ProcessEnv): EngineAiWiring {
  return {
    tokenFile: engineAiTokenPath(name, env),
    ...(ai?.gatewayUrl === undefined ? {} : { gatewayUrl: ai.gatewayUrl }),
  };
}

/**
 * What {@link restartMismatchedEngine} replaced, and where the new engine serves.
 * A restart binds a fresh port, so the URL is the thing the caller has to pass on.
 */
export interface RestartedEngine extends ReplacedEngine {
  /** Where the engine started in its place serves. */
  url: string;
  /** Where this project's engine served before, when it was recorded. */
  previousUrl: string | undefined;
  /** Whether Xano AI is on for the restarted engine, when {@link RestartEngineOptions.ai} asked. */
  ai?: AiOutcome;
}

/** What {@link restartMismatchedEngine} needs: the project, the engine it now resolves to, and the seams. */
export interface RestartEngineOptions {
  /** The project directory. Keys the record and derives the engine's name. */
  dir: string;
  /** The engine the caller already acquired and verified — nothing is fetched here. */
  acquired: AcquiredEngine;
  env?: NodeJS.ProcessEnv;
  run?: EngineRun;
  spawn?: EngineSpawn;
  /** The restarted engine's Xano AI credential, asked for before it starts. */
  ai?: EngineAiOptions;
}

/**
 * Replace this project's live engine when it is not the acquired binary — the
 * same KTD6 path {@link ensureProjectEngine} takes, with no deploy around it.
 *
 * Only a LIVE engine of another digest, or of this one started with other
 * telemetry variables, is touched: it is stopped by name, the
 * acquired binary is started under the same name, and the record is rewritten
 * as a fresh start (no completed-import marker, so the next `--keep-data`
 * deploy seeds it). No engine serving, or one already on this binary, is left
 * exactly as it is and answers `undefined` — nothing is started for a project
 * that had nothing running.
 */
export async function restartMismatchedEngine(opts: RestartEngineOptions): Promise<RestartedEngine | undefined> {
  const env = opts.env ?? process.env;
  const { entry, version } = opts.acquired;
  const shownVersion = version ?? overrideVersion(entry, env, opts.run);
  const dataDir = projectHasData(opts.dir) ? projectDataDir(opts.dir) : undefined;
  const { record, name, replaced } = reconcileLive(opts.dir, entry, shownVersion, env, opts.run, dataDir);
  if (replaced === undefined) return undefined;
  const ai = await engineAi(opts.ai, name, undefined, aiTtlFor(undefined, shownVersion, dataDir), env);
  const engine = await startEngine({
    entry,
    name,
    env,
    ...(shownVersion === undefined ? {} : { version: shownVersion }),
    ...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
    ai: wiringFor(name, ai, env),
    ...(dataDir === undefined ? {} : { dataDir }),
  });
  writeRecord(opts.dir, engine, entry, shownVersion, undefined, env, ai?.gatewayUrl, engineTelemetryEnv(env), dataDir);
  return { ...replaced, url: engine.url, previousUrl: record?.url, ...(ai === undefined ? {} : { ai }) };
}

/**
 * The engine serving this project, reconciled against the binary `entry` and
 * the caller's telemetry variables: kept when it IS that binary AND its record
 * says it was started with the same variables, stopped by name otherwise.
 *
 * `live` is the engine to reuse; `replaced` is set when one was stopped, and
 * the caller then starts `entry` under `name`.
 */
function reconcileLive(
  dir: string,
  entry: EngineCacheEntry,
  shownVersion: string | undefined,
  env: NodeJS.ProcessEnv,
  run: EngineRun | undefined,
  dataDir: string | undefined,
): { record: LocalEngineRecord | undefined; name: string; live: LocalEngine | undefined; replaced?: ReplacedEngine } {
  const record = getEngineRecord(dir, env);
  const name = record?.name ?? engineNameForProject(dir);
  const running = listEngines({ entry, env, ...(run === undefined ? {} : { run }) });
  if (dataDir !== undefined) refuseDataInUse(name, dataDir, running);
  const found = reuseCandidate(name, record, running);
  if (found === undefined) return { record, name, live: undefined };
  const sameBinary = record?.engineDigest === entry.digest;
  const telemetry = sameBinary
    ? telemetryChange(record?.telemetryEnv, engineTelemetryEnv(env), dataDir !== undefined || record?.dataDir !== undefined)
    : undefined;
  // The same binary with the same telemetry, but not on the data the project
  // has now: a project that gained `xano/data` (or lost it) restarts onto it.
  const data = sameBinary && telemetry === undefined && record?.dataDir !== dataDir ? (dataDir === undefined ? "throwaway" : "project") : undefined;
  if (sameBinary && telemetry === undefined && data === undefined) return { record, name, live: found };
  stopMismatched(found.name, record, entry, env, run, telemetry === undefined ? undefined : "telemetry");
  return {
    record,
    name,
    live: undefined,
    replaced: {
      name: found.name,
      from: record?.engineVersion,
      to: shownVersion,
      ...(telemetry === undefined ? {} : { telemetry }),
      ...(data === undefined ? {} : { data }),
      ...(dataDir === undefined ? {} : { onProjectData: true }),
    },
  };
}

/**
 * Refuse to start (or reuse) this project's engine on its data directory when
 * ANOTHER engine — under any other name — already runs on it: two processes on
 * one database is how its rows get corrupted. Read off the listing's own
 * account of each engine's database, which names the directory.
 */
function refuseDataInUse(name: string, dataDir: string, running: readonly LocalEngine[]): void {
  const spellings = pathSpellings(dataDir);
  const holder = running.find(
    (e) =>
      e.name !== name &&
      e.database !== undefined &&
      spellings.some((dir) => e.database!.endsWith(dir) || e.database!.includes(`${dir}${sep}`)),
  );
  if (holder === undefined) return;
  throw new Error(
    `Xano Engine "${holder.name}" is already running on this project's data in ${PROJECT_DATA_DIR}, ` +
      `and two engines on one database would damage it.\nStop it with \`xanosdk local stop ${holder.name}\`, then deploy again.`,
  );
}

/** `dir` as given and as resolved through symlinks (macOS's `/var` is `/private/var`). */
function pathSpellings(dir: string): string[] {
  try {
    const real = realpathSync(dir);
    return real === dir ? [dir] : [dir, real];
  } catch {
    return [dir];
  }
}

/**
 * Why a live engine started with `recorded` must not serve a caller who would
 * start one with `current`: the names whose value differs, in
 * {@link ENGINE_TELEMETRY_ENV} order and then any other recorded name;
 * `"unknown"` when the record cannot say; and `undefined` to reuse it.
 *
 * Reused when neither could report ({@link engineMayReport}): the restart would
 * drop the engine's rows and leave it as silent as before, which is what a
 * shell exporting `DO_NOT_TRACK=1` meets when it alternates with a launcher that
 * passes nothing. Otherwise exact strings over all five, set against unset
 * included: once either side may report, the opt-outs, the relay and the id all
 * decide what is sent, and a needless restart is the cheaper mistake.
 *
 * A record with no snapshot was written by an SDK from before it was kept. Most
 * such engines were started with none of the five, and a caller who neither
 * may report nor opts out reuses one, so upgrading the SDK does not restart
 * every engine. But that SDK also rewrites the whole row when it reuses an
 * engine, dropping the snapshot of one started opted in, so a caller who opts
 * out (or may report) restarts it once rather than trusting the gap.
 */
function telemetryChange(
  recorded: Record<string, string> | null | undefined,
  current: Record<string, string>,
  /**
   * A persistent engine (on a project's `xano/data`) is compared exactly: it
   * is not started `--ephemeral`, so the "neither could report" reading above
   * does not describe it, and restarting it costs no rows.
   */
  persistent = false,
): readonly string[] | "unknown" | undefined {
  if (recorded === null) return "unknown";
  if (recorded === undefined) {
    if (persistent) return Object.keys(current).length === 0 ? undefined : "unknown";
    return engineMayReport(current) || telemetryOptedOut(current) ? "unknown" : undefined;
  }
  if (!persistent && !engineMayReport(recorded) && !engineMayReport(current)) return undefined;
  const names = [...new Set([...ENGINE_TELEMETRY_ENV, ...Object.keys(recorded), ...Object.keys(current)])];
  const changed = names.filter((key) => recorded[key] !== current[key]);
  return changed.length === 0 ? undefined : changed;
}

/**
 * Write the project's record for the engine now serving it.
 *
 * `filled` is carried only when the caller decided the rows it vouches for are
 * still there; a fresh start passes `undefined`, since the new process holds
 * no rows.
 */
function writeRecord(
  dir: string,
  engine: LocalEngine,
  entry: EngineCacheEntry,
  shownVersion: string | undefined,
  filled: FilledMarker | undefined,
  env: NodeJS.ProcessEnv,
  aiGatewayUrl: string | undefined,
  telemetryEnv: Record<string, string> | null | undefined,
  dataDir: string | undefined,
): void {
  setEngineRecord(
    dir,
    {
      name: engine.name,
      url: engine.url,
      workspaceId: engine.workspaceId,
      project: dir,
      engineUrl: entry.url,
      engineDigest: entry.digest,
      ...(shownVersion === undefined ? {} : { engineVersion: shownVersion }),
      startedAt: Date.now(),
      ...(filled === undefined ? {} : { filled }),
      ...(aiGatewayUrl === undefined ? {} : { aiGatewayUrl }),
      ...(telemetryEnv === undefined ? {} : { telemetryEnv }),
      ...(dataDir === undefined ? {} : { dataDir }),
    },
    env,
  );
}

/**
 * An override binary's version, read off its own `version` output, or
 * `undefined` when it cannot say.
 *
 * Read through {@link engineVersionToken}, the one reading of that output.
 */
function overrideVersion(
  entry: EngineCacheEntry,
  env: NodeJS.ProcessEnv,
  run: EngineRun | undefined,
): string | undefined {
  let out: string;
  try {
    out = askEngineVersion({ entry, env, ...(run === undefined ? {} : { run }) });
  } catch {
    return undefined;
  }
  return engineVersionToken(out);
}

/**
 * Stop the live engine this project no longer resolves to, by name. `why` is
 * `"telemetry"` when it is the right binary started with other telemetry
 * variables, which only the refusal's wording turns on.
 *
 * First through the binary just acquired — engine run records are kept under
 * the user's home, so one version can normally stop another. If that binary
 * cannot, the version the engine was recorded as is tried through its OWN
 * cached binary before giving up. When neither can, this refuses rather than
 * starting a second engine beside the first under the same name.
 */
function stopMismatched(
  name: string,
  record: LocalEngineRecord | undefined,
  entry: EngineCacheEntry,
  env: NodeJS.ProcessEnv,
  run: EngineRun | undefined,
  why: "telemetry" | undefined,
): void {
  const seam = run === undefined ? {} : { run };
  const attempt = (binary: EngineCacheEntry): boolean => {
    try {
      return stopEngineNamed(name, { entry: binary, env, ...seam }).stopped;
    } catch {
      return false;
    }
  };
  if (attempt(entry)) return;

  // Only another binary is a second try: a telemetry restart is of this one.
  const previous = recordedBinary(record, env);
  const second = previous !== undefined && previous.digest !== entry.digest ? previous : undefined;
  if (second !== undefined && attempt(second)) return;

  const mismatch =
    why === "telemetry"
      ? `was started with other telemetry settings than this deploy's`
      : `is not the engine this deploy resolved to`;
  throw new Error(
    `The Xano Engine "${name}" already serving this project ${mismatch}, and it could not be stopped` +
      (second === undefined ? `` : ` by either engine version`) +
      `.\nStop it with \`xanosdk local stop ${name}\` (or end the process), then deploy ` +
      `again.`,
  );
}

/** The cached binary for the version a record names, when it is a release that is still cached. */
function recordedBinary(
  record: LocalEngineRecord | undefined,
  env: NodeJS.ProcessEnv,
): EngineCacheEntry | undefined {
  const version = record?.engineVersion;
  if (version === undefined || !RELEASE_VERSION.test(version)) return undefined;
  try {
    return readEngineEntry({ version }, env);
  } catch {
    return undefined;
  }
}

/**
 * The engine already serving this project, or `undefined` to start one.
 *
 * Two ways in, because they answer to different guards. With a record, {@link
 * resolveRecordedEngine} is the reconciler — it owns the loopback refusal on
 * the reuse arm and the wording that goes with it. Without one, the derived
 * name is still the right question to ask the enumeration, and the same
 * loopback gate is applied by hand rather than skipped.
 */
function reuseCandidate(
  name: string,
  record: LocalEngineRecord | undefined,
  running: readonly LocalEngine[],
): LocalEngine | undefined {
  if (record !== undefined) {
    const resolved = resolveRecordedEngine(record, running);
    if (resolved.state === "unusable") throw new Error(resolved.reason);
    return resolved.state === "live" ? resolved.engine : undefined;
  }

  const engine = running.find((e) => e.name === name);
  if (engine === undefined) return undefined;
  // No record, but the name is derived — this is this project's own engine from
  // a deploy whose record is gone. It still has to pass the gate the recorded
  // arm passes before its token is used.
  assertLoopbackUrl(engine.url, "The engine already serving this project");
  return engine;
}

/** What {@link explainUnsupportedEngineImport} knows beyond the failure. */
export interface UnsupportedImportContext {
  /**
   * The newest published engine for this machine, as the update check last
   * read it; `undefined` when it cannot be known. Only a release newer than the
   * serving engine makes "older than this SDK needs" true.
   */
  latest?: string | undefined;
  /**
   * Set on a keep-data merge: this run's command with `--reset` added — the
   * deploy that works when the merge itself is what the engine cannot do.
   */
  resetRerun?: string | undefined;
  /**
   * Set on a merge into an engine on the project's own data (`xano/data`),
   * which a deploy never replaces: there is no `--reset` to offer.
   */
  projectData?: boolean;
}

/**
 * An import the serving engine does not implement, in the SDK's words.
 *
 * The engine answers 501, and its own message names internals that mean nothing
 * to the reader and point at no fix. Which fix is real depends on the release
 * list: an engine behind a newer release is told to move to it; the newest one
 * is not told to upgrade to itself (E2E pass 28 — the remedy looped). A merge
 * then says the deploy that works, and what it costs the rows. Undefined for
 * any other failure, which passes through unchanged.
 */
export function explainUnsupportedEngineImport(
  err: unknown,
  engineVersion: string | undefined,
  ctx: UnsupportedImportContext = {},
): Error | undefined {
  if (!(err instanceof ImportHttpError) || err.status !== 501) return undefined;
  const which = engineVersion === undefined ? "The Xano Engine" : `Xano Engine ${engineVersion}`;
  const newer = newerRelease(engineVersion, ctx.latest);
  if (newer !== undefined) {
    return new Error(
      `${which} does not support this import (HTTP 501): it is older than this SDK needs. Nothing was written. ` +
        `Deploy with ${newer} — \`xanosdk local update\` moves this project's pin to it, ` +
        `or pass \`--local=${newer}\` for one deploy.`,
      { cause: err },
    );
  }
  if (ctx.projectData === true) {
    return new Error(
      `${which} cannot apply this merge (HTTP 501): keeping the rows through this schema change is not available ` +
        `on the Xano Engine yet. Nothing was written. This project runs on its own data in ${PROJECT_DATA_DIR}, which ` +
        `a deploy never replaces: make the change in a way that keeps the rows (add the new shape beside the old one), ` +
        `or move ${PROJECT_DATA_DIR} out of the project to deploy onto a throwaway engine instead.`,
      { cause: err },
    );
  }
  if (ctx.resetRerun !== undefined) {
    return new Error(
      `${which} cannot apply this merge (HTTP 501): keeping the rows through this schema change is not available ` +
        `on the Xano Engine yet. Nothing was written. Deploy with \`${ctx.resetRerun}\` instead — it replaces ` +
        `the workspace and writes every table's seed rows, so rows entered since the last deploy are lost.`,
      { cause: err },
    );
  }
  return new Error(
    `${which} does not support this import (HTTP 501). Nothing was written. ` +
      `\`xanosdk deploy --ephemeral\` deploys to an ephemeral meanwhile.`,
    { cause: err },
  );
}

/** `latest` when it is strictly newer than `current`; undefined when either is unknown. */
function newerRelease(current: string | undefined, latest: string | undefined): string | undefined {
  if (current === undefined || latest === undefined) return undefined;
  const a = parseSemver(current);
  const b = parseSemver(latest);
  return a !== null && b !== null && compareSemver(b, a) > 0 ? latest : undefined;
}
