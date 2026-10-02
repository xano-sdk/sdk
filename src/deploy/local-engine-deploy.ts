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
 * Node-only, reached by a lazy import from the command layer.
 */
import { acquireEngine, type AcquiredEngine, type EngineFetch } from "./local-engine-release.js";
import { readEngineEntry, RELEASE_VERSION, type EngineCacheEntry } from "./local-engine-cache.js";
import type { EngineSourceSpec } from "./local-engine-config.js";
import { assertLoopbackUrl, type LocalEngine } from "./local-engine-handshake.js";
import {
  engineVersion as askEngineVersion,
  engineVersionToken,
  listEngines,
  resolveRecordedEngine,
  startEngine,
  stopEngineNamed,
  stopOrphanedEngineProcesses,
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
import { ImportHttpError } from "./import.js";
import { compareSemver, parseSemver } from "../emit/semver.js";

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
}

/** A live engine this run stopped because it was not the engine it resolved to. */
export interface ReplacedEngine {
  name: string;
  /** The version the stopped engine was recorded as, when it was recorded at all. */
  from: string | undefined;
  /** The version started in its place, when known. */
  to: string | undefined;
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
 * only there. The same failures reached from a `local-engine` verb (a bad
 * `cache clear --version`, a `stop` with nothing cached) are about the engine
 * the reader asked for by name, and pointing at the ephemeral arm there reads
 * as an unrelated aside.
 */
export const DEPLOY_FALLBACK_NOTE = "Meanwhile `xanosdk deploy` still deploys to an ephemeral.";

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
  });
  const { entry, version } = acquired;
  opts.onAcquired?.(acquired);

  // A release's version comes from resolution; an override is asked, as
  // `local-engine list` asks. Best-effort — it is for display, and an engine
  // that cannot say is still an engine.
  const shownVersion = version ?? overrideVersion(entry, env, opts.run);

  const { record, name, live, replaced } = reconcileLive(opts.dir, entry, shownVersion, env, opts.run);

  // Before a fresh start: an engine killed outright left its helper processes
  // serving, holding their data and ports, and nothing lists them (E2E pass 26).
  const sweep = opts.sweepOrphans ?? (opts.spawn === undefined ? () => stopOrphanedEngineProcesses({ env }).stopped : undefined);
  const sweptOrphans = live === undefined && sweep !== undefined ? sweep() : [];

  const engine =
    live ??
    (await startEngine({
      entry,
      name,
      env,
      ...(shownVersion === undefined ? {} : { version: shownVersion }),
      ...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
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
  writeRecord(opts.dir, engine, entry, shownVersion, reused && carry ? priorFilled : undefined, env);
  // A DEPLOY to this engine, so the project's bare commands now follow it.
  // Here, beside the deploy's record write — never inside `writeRecord`, which
  // the `local-engine update` restart also reaches: a restart is not a deploy,
  // and must not pull a project iterating on an ephemeral over to the engine.
  // Only for an engine this call started: a reused one is recorded by the
  // deploy once its import is sent, so a refused `--keep-data` preview leaves
  // the pointer as it was (E2E pass 27: it rewrote `deployedAt`).
  if (!reused) recordDeployed(opts.dir, "local-engine");

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
}

/**
 * Replace this project's live engine when it is not the acquired binary — the
 * same KTD6 path {@link ensureProjectEngine} takes, with no deploy around it.
 *
 * Only a LIVE engine of another digest is touched: it is stopped by name, the
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
  const { record, name, replaced } = reconcileLive(opts.dir, entry, shownVersion, env, opts.run);
  if (replaced === undefined) return undefined;
  const engine = await startEngine({
    entry,
    name,
    env,
    ...(shownVersion === undefined ? {} : { version: shownVersion }),
    ...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
  });
  writeRecord(opts.dir, engine, entry, shownVersion, undefined, env);
  return { ...replaced, url: engine.url, previousUrl: record?.url };
}

/**
 * The engine serving this project, reconciled against the binary `entry`: kept
 * when it IS that binary, stopped by name when it is not.
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
): { record: LocalEngineRecord | undefined; name: string; live: LocalEngine | undefined; replaced?: ReplacedEngine } {
  const record = getEngineRecord(dir, env);
  const name = record?.name ?? engineNameForProject(dir);
  const running = listEngines({ entry, env, ...(run === undefined ? {} : { run }) });
  const found = reuseCandidate(name, record, running);
  if (found === undefined || record?.engineDigest === entry.digest) return { record, name, live: found };
  stopMismatched(found.name, record, entry, env, run);
  return { record, name, live: undefined, replaced: { name: found.name, from: record?.engineVersion, to: shownVersion } };
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
 * Stop the live engine this project no longer resolves to, by name.
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

  const previous = recordedBinary(record, env);
  if (previous !== undefined && previous.digest !== entry.digest && attempt(previous)) return;

  throw new Error(
    `The local engine "${name}" already serving this project is not the engine this deploy ` +
      `resolved to, and it could not be stopped` +
      (previous === undefined ? `` : ` by either engine version`) +
      `.\nStop it with \`xanosdk local-engine stop ${name}\` (or end the process), then deploy ` +
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
  const which = engineVersion === undefined ? "The local engine" : `Local engine ${engineVersion}`;
  const newer = newerRelease(engineVersion, ctx.latest);
  if (newer !== undefined) {
    return new Error(
      `${which} does not support this import (HTTP 501): it is older than this SDK needs. Nothing was written. ` +
        `Deploy with ${newer} — \`xanosdk local-engine update\` moves this project's pin to it, ` +
        `or pass \`--local-engine=${newer}\` for one deploy.`,
      { cause: err },
    );
  }
  if (ctx.resetRerun !== undefined) {
    return new Error(
      `${which} cannot apply this merge (HTTP 501): keeping the rows through this schema change is not available ` +
        `on the local engine yet. Nothing was written. Deploy with \`${ctx.resetRerun}\` instead — it replaces ` +
        `the workspace and writes every table's seed rows, so rows entered since the last deploy are lost.`,
      { cause: err },
    );
  }
  return new Error(
    `${which} does not support this import (HTTP 501). Nothing was written. ` +
      `\`xanosdk deploy\` deploys to an ephemeral meanwhile.`,
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
