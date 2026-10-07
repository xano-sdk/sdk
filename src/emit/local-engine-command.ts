/**
 * `xanosdk local <list|token|mcp|stop|update|cache>` — the handles
 * that ship with `deploy --local`.
 *
 * A Xano Engine has no TTL and nothing on the server side ever reclaims it,
 * and the binary it runs from lives in a hidden cache directory that is never
 * on `PATH`. So the only way a developer reclaims one is a verb this tool owns:
 * printing the engine's own invocation would hand them a path to copy, for a
 * file they were never told about.
 *
 * Four things here are load-bearing:
 *
 * **The enumeration is the oracle; a record is a hint.** `list` reports what
 * the engine says is running and marks each row against the records, never the
 * other way round — a row for an engine that died would otherwise read as
 * running. Matching is by NAME, and nothing here ever signals a pid.
 *
 * **The enumeration carries a bearer per engine.** It is how the reuse path
 * gets a token without anything on disk holding one, and it means the raw
 * listing must never be printed. Every row this module builds is assembled
 * field by field from the fields that are safe to show, so the token and the
 * sign-in url cannot reach stdout, a log, or the machine output by being
 * forgotten.
 *
 * **`token` is the one verb that prints the bearer, because it was asked to.**
 * The engine's meta API accepts only its own bearer, so a suite or script that
 * calls it has no other way in. Printing it on request is the same contract as
 * a hosted `XANO_META_TOKEN` a developer copies out of their account — what
 * stays forbidden is printing it as a side effect of another verb. `mcp` reads
 * it too, and only ever SENDS it (`local-engine-mcp-command.ts`).
 *
 * Opening one in the builder is not a verb here: `xanosdk impersonate
 * local[:name]` does it, the same verb and output as every other kind.
 *
 * **Which cached binary runs a verb (KTD7).** The project's pinned version when
 * it is cached, else the newest cached release, else the newest override. Any
 * of them can list and stop an engine another version started (measured), so
 * the choice is about predictability, not reach.
 *
 * **`update` and `cache` are the deliberate verbs.** `update` moves the pin a
 * deploy only ever offers to move, and never prompts: running it is the
 * confirmation. `cache clear` stops every engine running on a binary it is
 * about to delete, BEFORE deleting, and through a binary it is keeping when
 * there is one.
 *
 * Node-only (it runs the engine's own verbs and reads the cache), lazily
 * imported from `cli.ts` like its siblings.
 */
import { readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { ParsedArgs } from "./cli.js";
import { suggest } from "./commands.js";
import { suggestAll } from "../util/suggest.js";
import { UsageError, unknownSubcommand } from "./errors.js";
import { isMachineOutput, writeJson } from "./output.js";
import { detail, info, link, printHuman, stdoutStyle, success, warn } from "./ui.js";
import type { DevEnvSync } from "./dev-env-sync.js";
import {
  diskBytes,
  listLegacyCacheDirs,
  listOverrideEntries,
  listReleaseEntries,
  readEngineEntry,
  type EngineCacheEntry,
} from "../deploy/local-engine-cache.js";
import {
  engineRunHome,
  legacyRuntimeDirs,
  localEngineBinDir,
  resolveEnginePlatform,
  SUPPORTED_PLATFORMS,
} from "../deploy/local-engine-config.js";
import { confirm } from "./prompt.js";
import { yesRerun } from "./retry-command.js";
import { restartMismatchedEngine, type RestartedEngine } from "../deploy/local-engine-deploy.js";
import { readPin, writePin } from "../deploy/local-engine-pin.js";
import { pinWrittenText } from "./local-engine-choice.js";
import { resolveProjectEntry } from "./deploy-source.js";
import {
  ENGINE_RELEASES_URL_ENV,
  normalizeEngineVersion,
  resolveEngineRelease,
  usesCustomReleaseManager,
} from "../deploy/local-engine-releases.js";
import type { LocalEngine } from "../deploy/local-engine-handshake.js";
import { NO_CREDENTIAL, resolveSource, SourceError } from "./source-resolve.js";
import {
  cachedEngineEntry,
  engineVersion,
  engineVersionToken,
  listEngines,
  stopAllEngines,
  stopEngineNamed,
  stopOrphanedEngineProcesses,
  findOrphanedEngineProcesses,
  type OrphanSweep,
  type OrphanSweepOptions,
  type ProcessSignal,
  type ProcessTable,
  type EngineRun,
  type EngineSpawn,
  type StopOutcome,
} from "../deploy/local-engine-process.js";
import { acquireEngine, type EngineFetch } from "../deploy/local-engine-release.js";
import {
  clearEngineRecordsNamed,
  clearEngineRecordsStillMatching,
  listEngineRecords,
  type LocalEngineRecord,
} from "../deploy/local-engine-state.js";

/**
 * The seams the layers below already take, threaded through so this command's
 * tests drive canned engine answers instead of mocking a module. The defaults
 * are the real environment, a real subprocess, and a real request.
 */
export interface LocalEngineCommandOptions {
  env?: NodeJS.ProcessEnv;
  run?: EngineRun;
  /**
   * The request seam `update` downloads through. Threaded for the same reason
   * as `run`: the refusal paths assert that it was NEVER called.
   */
  fetch?: EngineFetch;
  /** The detached-start seam `update` restarts a live engine through. */
  spawn?: EngineSpawn;
  /**
   * The machine `update` resolves a release for. Defaulted to the running
   * process; a seam so a test can ask for a platform's release on any machine.
   */
  platform?: string;
  arch?: string;
  /**
   * The process-table and signal seams `stop --all` sweeps a crashed engine's
   * leftovers through, and how long it waits for them — so a test asserts what
   * would be stopped without a real process table.
   */
  processes?: ProcessTable;
  signal?: ProcessSignal;
  orphanWaitMs?: number;
}

/** One `cache list` row: a cached engine, how much disk it holds, and what runs on it. */
export interface LocalEngineCacheRow {
  /**
   * The release version (`v0.1.5`), `"override"` for an operator-named engine,
   * `"legacy"` for a directory in the old cache layout that nothing runs from,
   * `"runtime"` for the files the engines unpacked beside the cache, or
   * `"legacy-runtime"` for the copy earlier versions unpacked in the user's own
   * cache directory (cleared only by `cache clear --legacy-runtime`).
   */
  version: string;
  source: "release" | "override" | "legacy" | "runtime" | "legacy-runtime";
  /**
   * The entry's directory name — `v0.1.5`, `src-<hash>` for an override, a bare
   * hash for legacy — or, for the two runtime rows, the directory's full path.
   */
  id: string;
  /** Bytes on disk. */
  bytes: number;
  /** Running engines started from this exact binary (matched by recorded digest). */
  engines: string[];
}

/** One `list` row: the engine, minus everything that opens a session. */
export interface LocalEngineRow {
  /** The engine's name — the handle `stop` takes. */
  name: string;
  /** Where it serves. */
  url: string;
  /** The workspace it stands up. */
  workspaceId: number;
  /** Does a record on this machine claim it? The false case is a foreign engine. */
  startedByXanoSdk: boolean;
  /** The project whose record names it, when one does. */
  project?: string;
  /** Set when the engine it was started from is not the engine cached now. */
  engineMismatch?: {
    /** What the record says it was started from — a version, or the digest. */
    startedFrom: string;
    /** The cached engine's version, as the one token its `version` output leads with. */
    cached: string;
  };
}

export async function runLocalEngineCommand(
  args: ParsedArgs,
  opts: LocalEngineCommandOptions = {},
): Promise<void> {
  switch (args.subcommand) {
    case "list":
      return runList(args, opts);
    case "token":
      return runToken(args, opts);
    case "mcp":
      return (await import("./local-engine-mcp-command.js")).runMcp(args, opts);
    case "stop":
      return runStop(args, opts);
    case "update":
      return runUpdate(args, opts);
    case "cache":
      return runCache(args, opts);
    default:
      throw unknownSubcommand("local", args.subcommand, args.positionals);
  }
}

/** {@link cachedEngineEntry} for this project directory — the binary every verb here runs from. */
function cachedEngine(
  env: NodeJS.ProcessEnv,
  exclude: ReadonlySet<string> = new Set(),
): EngineCacheEntry | undefined {
  return cachedEngineEntry(env, process.cwd(), exclude);
}

// ── list ────────────────────────────────────────────────────────────────────

/**
 * Every engine running on this machine, marked ours or foreign.
 *
 * The engine's own enumeration, reconciled against the records — not a
 * listing OF the records, which would report an engine that is already gone.
 */
async function runList(args: ParsedArgs, opts: LocalEngineCommandOptions): Promise<void> {
  const env = opts.env ?? process.env;
  const entry = cachedEngine(env);
  // No cached engine means no engine to ASK, and also means nothing could have
  // been started — starting goes through this same cache. Empty is the honest
  // answer, and the one the overwhelmingly common "never used this" case needs.
  const orphans = findOrphanedEngineProcesses(sweepOptions(opts, env)).map((p) => p.pid);
  if (entry === undefined) return report([], args, orphans);

  const running = listEngines({ entry, env, run: opts.run });
  const byName = new Map(listEngineRecords(env).map((r) => [r.name, r] as const));
  // Asked for at most once, and only when a mismatch is already known to exist:
  // it costs a subprocess, and the answer is the same for every row.
  let cached: string | undefined;

  const rows: LocalEngineRow[] = running.map((engine) => {
    const record = byName.get(engine.name);
    const row: LocalEngineRow = {
      name: engine.name,
      url: engine.url,
      workspaceId: engine.workspaceId,
      startedByXanoSdk: record !== undefined,
    };
    if (record === undefined) return row;
    row.project = record.project;
    if (record.engineDigest !== entry.digest) {
      cached ??= engineVersionToken(engineVersion({ entry, env, run: opts.run })) ?? "unknown";
      row.engineMismatch = { startedFrom: startedFrom(record), cached };
    }
    return row;
  });
  report(rows, args, orphans);
}

/** How the record names the engine it was started from: its version, else its digest. */
function startedFrom(record: LocalEngineRecord): string {
  return record.engineVersion ?? `engine ${record.engineDigest.slice(0, 12)}`;
}

function report(rows: readonly LocalEngineRow[], args: ParsedArgs, orphans: readonly number[] = []): void {
  // What a crashed engine left running is in no engine's listing, so it is said
  // here rather than left for the reader to find in a process monitor.
  if (orphans.length > 0) {
    info(
      `${orphans.length === 1 ? "A process" : `${orphans.length} processes`} a crashed Xano Engine left running ` +
        `(pid ${orphans.join(", ")}) — \`xanosdk local stop --all\` stops ${orphans.length === 1 ? "it" : "them"}.`,
    );
  }
  if (isMachineOutput(args)) {
    writeJson({ engines: rows, ...(orphans.length === 0 ? {} : { orphanedProcesses: orphans }) });
    reportMismatches(rows);
    return;
  }
  const s = stdoutStyle();
  if (rows.length === 0) {
    process.stdout.write("No Xano Engine is running\n");
    return;
  }
  const lines = rows.map((row) => {
    // The name leads (bold) because it is the handle `stop` takes; the owner
    // trails, and a foreign engine is coloured because it is the row that
    // explains why `stop --all` left something behind.
    const owner = row.startedByXanoSdk
      ? s.dim(row.project ?? "")
      : s.yellow("foreign — not started by xanosdk");
    return `  ${s.bold(row.name)}  ${s.cyan(row.url)}  ${owner}`;
  });
  printHuman(lines.join("\n") + "\n");
  reportMismatches(rows);
}

/**
 * Say, on stderr, that an engine is not the one cached here.
 *
 * Reported rather than quietly reused: the engine a backend was stood up on
 * decides what that backend can do, and a deploy that reuses across a version
 * difference is the one that produces an unexplainable failure later.
 */
function reportMismatches(rows: readonly LocalEngineRow[]): void {
  for (const row of rows) {
    if (row.engineMismatch === undefined) continue;
    // Both versions named, each with its side: one parenthesised version after
    // "the one cached here" read as the CACHED one, when it was the running one.
    const { startedFrom: from, cached } = row.engineMismatch;
    const running = from.startsWith("engine ") ? from : `engine ${from}`;
    warn(
      `${row.name} is running ${running}, but the engine cached here is ${cached}.`,
      "local.stale",
      [
        `Deploy its project again with \`xanosdk deploy --local\` to restart it on that project's ` +
          `pinned engine, or stop it with \`xanosdk local stop ${row.name}\`.`,
      ],
    );
  }
}

// ── stop ────────────────────────────────────────────────────────────────────

async function runStop(args: ParsedArgs, opts: LocalEngineCommandOptions): Promise<void> {
  const env = opts.env ?? process.env;
  const name = args.positionals[0];
  if (args.all && name !== undefined && name !== "") {
    throw new UsageError(
      `\`xanosdk local stop\` takes a name or \`--all\`, not both — \`--all\` already covers ` +
        `"${name}". Drop one of them.`,
      { hintFor: { command: "local", subcommand: "stop" } },
    );
  }
  if (args.all) return runStopAll(args, opts, env);
  if (name === undefined || name === "") {
    throw new UsageError(
      `\`xanosdk local stop\` needs the name of an engine, or \`--all\` for every engine xanosdk ` +
        `started on this machine, across projects. Run \`xanosdk local list\` to see them.`,
      { hintFor: { command: "local", subcommand: "stop" } },
    );
  }
  // `stop STRIPE=sk_…` is an assignment, never an engine's name (they are
  // derived, `xanosdk-<hash>`) — refused, value unrepeated, rather than answered
  // "not running" with the whole word echoed into a success document.
  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(name);
  if (assignment !== null) {
    throw new UsageError(
      `"${assignment[1]}=…" is not a Xano Engine name. Run \`xanosdk local list\` to see what is running.`,
      { hintFor: { command: "local", subcommand: "stop" } },
    );
  }
  return runStopNamed(name, args, opts, env);
}

/** Stop the named engine, and clear every record that named it. */
async function runStopNamed(
  name: string,
  args: ParsedArgs,
  opts: LocalEngineCommandOptions,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const entry = cachedEngine(env);
  // With no cached engine nothing could have been started — starting goes
  // through this same cache — so the engine is already stopped. Its records
  // are hints to something that cannot be running, and are cleared.
  const outcome: StopOutcome =
    entry === undefined
      ? { name, stopped: false, clearedProjects: clearEngineRecordsNamed(name, env) }
      : stopEngineNamed(name, { entry, env, run: opts.run });
  // A stop is a delete of a running thing, so "already stopped" is the outcome
  // it asked for: exit 0 with `alreadyStopped`, the way `release delete` and
  // `ephemeral delete` answer `alreadyGone`. Said distinctly — and with the
  // listing named — so a typo'd name is still visible. The line goes to
  // stderr piped or not, as `ephemeral delete`'s does; the document follows.
  if (!outcome.stopped) {
    info(`"${name}" is not running — nothing to stop${clearedSuffix(outcome)}.`);
    // A one-letter slip still exits 0 — the engine asked for IS stopped — but
    // the one that runs under a near-identical name is named, not left running.
    const nearest = entry === undefined ? undefined : nearestRunning(name, entry, env, opts);
    if (nearest !== undefined) detail(`Did you mean \`${nearest}\`? It is running: \`xanosdk local stop ${nearest}\`.`);
    else detail("Run `xanosdk local list` to see what is running.");
    if (isMachineOutput(args)) writeJson({ ...outcome, alreadyStopped: true, ...(nearest === undefined ? {} : { suggestion: nearest }) });
    return;
  }
  success(`Stopped ${name}${clearedSuffix(outcome)}`);
  if (isMachineOutput(args)) writeJson({ ...outcome, alreadyStopped: false });
}

/** The running engine whose name is one slip from `name`, if one is. */
function nearestRunning(
  name: string,
  entry: NonNullable<ReturnType<typeof cachedEngine>>,
  env: NodeJS.ProcessEnv,
  opts: LocalEngineCommandOptions,
): string | undefined {
  try {
    return suggest(name, listEngines({ entry, env, run: opts.run }).map((e) => e.name));
  } catch {
    return undefined;
  }
}

/** Every engine THIS tool started, across every project on the machine. */
async function runStopAll(
  args: ParsedArgs,
  opts: LocalEngineCommandOptions,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const entry = cachedEngine(env);
  // Same reasoning as `list`: with no cached engine nothing could have been
  // started, so "nothing to stop" is the answer rather than a refusal. The
  // records are still cleared, because they are hints to engines that by the
  // same reasoning cannot be running.
  if (entry === undefined) {
    const records = listEngineRecords(env);
    const orphans = stopOrphanedEngineProcesses(sweepOptions(opts, env));
    return reportStopAll({ stopped: [], foreign: [], orphans }, clearEngineRecordsStillMatching(records, env), args);
  }
  const outcome = stopAllEngines({ entry, run: opts.run, ...sweepOptions(opts, env) });
  // `stopAllEngines` cleared the record of every engine it stopped, and a
  // foreign engine has no record. What is left to clear are the records it saw
  // name an engine that was not running, and only if unchanged: a deploy that
  // started an engine since the listing has written a record this must keep.
  reportStopAll(outcome, clearEngineRecordsStillMatching(outcome.stale, env), args);
}

/** The sweep's seams, off this command's. */
export function sweepOptions(opts: LocalEngineCommandOptions, env: NodeJS.ProcessEnv): OrphanSweepOptions {
  return {
    env,
    ...(opts.processes === undefined ? {} : { processes: opts.processes }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.orphanWaitMs === undefined ? {} : { waitMs: opts.orphanWaitMs }),
  };
}

/**
 * Say what a sweep stopped: the processes a crashed engine left running, which
 * no listing shows. Nothing when there were none.
 */
export function reportOrphanSweep(orphans: OrphanSweep): void {
  const n = orphans.stopped.length;
  if (n > 0) {
    success(
      `Stopped ${n} process${n === 1 ? "" : "es"} a crashed Xano Engine left running ` +
        `(pid ${orphans.stopped.join(", ")}).`,
    );
  }
  if (orphans.stillRunning.length > 0) {
    detail(
      `Still exiting after the wait: pid ${orphans.stillRunning.join(", ")} — ` +
        `run \`xanosdk local stop --all\` again in a moment.`,
    );
  }
}

function reportStopAll(
  outcome: { stopped: StopOutcome[]; foreign: string[]; orphans: OrphanSweep },
  staleProjects: string[],
  args: ParsedArgs,
): void {
  // The lines go to stderr piped or not, as a named stop's do; the document follows.
  for (const stop of outcome.stopped) {
    if (stop.stopped) success(`Stopped ${stop.name}${clearedSuffix(stop)}`);
    else warn(`${stop.name} was listed as running but did not stop${clearedSuffix(stop)}.`, "local.stop-failed");
  }
  if (outcome.foreign.length > 0) {
    // Reported rather than silently skipped: a developer who ran `stop --all`
    // and still sees an engine needs to be told which one, and why.
    warn(
      `Left running, not started by xanosdk: ${outcome.foreign.join(", ")}`,
      "local.foreign",
      ["Name one explicitly — `xanosdk local stop <name>` — to stop it anyway."],
    );
  }
  reportOrphanSweep(outcome.orphans);
  if (staleProjects.length > 0) {
    detail(`Cleared ${staleProjects.length} stale record${staleProjects.length === 1 ? "" : "s"}.`);
  }
  const swept = outcome.orphans.stopped.length + outcome.orphans.stillRunning.length;
  if (outcome.stopped.length === 0 && outcome.foreign.length === 0 && swept === 0) {
    info("No Xano Engine is running — nothing to stop.");
  }
  if (isMachineOutput(args)) {
    // `alreadyStopped`, the key a named stop carries: none of ours was running
    // and nothing was left behind, so there was nothing to stop. `orphans`:
    // the pids a crashed engine left running, stopped (or still exiting).
    writeJson({ ...outcome, staleProjects, alreadyStopped: outcome.stopped.length === 0 && swept === 0 });
  }
}

/** " (cleared its record in 2 projects)", or nothing when it cleared none. */
function clearedSuffix(outcome: StopOutcome): string {
  const n = outcome.clearedProjects.length;
  if (n === 0) return "";
  return n === 1 ? " (cleared its local record)" : ` (cleared its record in ${n} projects)`;
}

// ── token ───────────────────────────────────────────────────────────────────

/**
 * Print a live engine's meta API bearer — the local stand-in for the
 * `XANO_META_TOKEN` a hosted run reads.
 *
 * Bare on stdout in every mode, not only on a terminal: the form this exists
 * for is `XANO_META_TOKEN=$(xanosdk local token)`, which is piped, and a
 * JSON document there would be a token nobody can use. `--json` asks for the
 * document explicitly, and carries the url and workspace the bearer is for.
 *
 * Read off the enumeration at the moment of asking, like every other verb here:
 * a restarted engine re-mints its bearer, so a value captured before a restart
 * is dead and the fix is to run this again.
 */
async function runToken(args: ParsedArgs, opts: LocalEngineCommandOptions): Promise<void> {
  const engine = await targetEngine(args, opts, "read a token from");
  if (args.json) {
    // Field by field, for the reason `list` is: the sign-in url opens an owner
    // session and has no business in a document meant for a meta API client.
    writeJson({ name: engine.name, url: engine.url, workspaceId: engine.workspaceId, token: engine.token });
    return;
  }
  process.stdout.write(engine.token + "\n");
}

// ── shared ──────────────────────────────────────────────────────────────────

/**
 * The live engine a per-engine verb acts on: the one named, else this project's.
 *
 * `doing` finishes the no-cached-engine refusal ("nothing here to read a token
 * from"), the only line that differs between the verbs that go through here.
 */
function targetEngine(args: ParsedArgs, opts: LocalEngineCommandOptions, doing: string): Promise<LocalEngine> {
  return resolveLiveEngine(args.positionals[0], opts, doing);
}

/**
 * {@link targetEngine} for a caller whose positionals mean something else —
 * `env set NAME` — so the engine name is passed rather than read off them.
 * Undefined or empty means this project's engine.
 *
 * A thin wrapper over the selector resolver's local arm, so `local:<name>`
 * on any command and a name given to a verb here reach the same engine through
 * the same gate: named or recorded, checked against the enumeration, stale
 * records cleared, loopback enforced before the bearer comes back. The one
 * thing added here is the no-cached-engine refusal in the verb's own words —
 * checked first, as it always was, because the enumeration needs a binary.
 *
 * The name is OPTIONAL, unlike `stop`'s: a Xano Engine's name is DERIVED from
 * the project path rather than chosen, so nobody types one by hand, and bare
 * is the form every ordinary run wants.
 */
export async function resolveLiveEngine(
  named: string | undefined,
  opts: LocalEngineCommandOptions,
  doing: string,
): Promise<LocalEngine> {
  const env = opts.env ?? process.env;
  const entry = cachedEngine(env);
  if (entry === undefined) {
    // Not-found, exit 8 — the same answer as a cached engine that does not hold
    // the name. With nothing cached, nothing can be running.
    throw new SourceError(
      `No engine is cached on this machine, so there is nothing here to ${doing}.\n` +
        `Run \`xanosdk deploy --local\` to fetch one if you meant to use a Xano Engine.`,
      "gone",
      "local",
    );
  }
  const resolved = await resolveSource(
    named === undefined || named === "" ? { kind: "local" } : { kind: "local", name: named },
    NO_CREDENTIAL,
    // A lifecycle verb manages the engine itself; "deploy still reaches an
    // ephemeral" answers a question nobody running it asked.
    // The name is this verb's bare positional, so a near one is suggested bare.
    { env, listEngines: () => listEngines({ entry, env, run: opts.run }), deployFallback: false, bareName: true },
  );
  // The local arm always answers with a local backend; narrowed for the type.
  if (resolved.backend.kind !== "local") throw new Error("Internal: a Xano Engine resolved to a hosted backend.");
  return resolved.backend.engine;
}

// ── update ──────────────────────────────────────────────────────────────────

/**
 * Move this project's pin to the latest engine, or to `--version <v>`.
 *
 * The order is what keeps the pin honest: resolve, ACQUIRE, then write the pin
 * — a version that does not exist or fails to download never reaches
 * `package.json`. Already on the target is an answer, not work: no write, no
 * download, and nothing running is touched.
 *
 * A live engine on another binary is replaced through the deploy's own KTD6
 * path (stopped by name, the new binary started, recorded as a fresh start).
 * The new engine holds no workspace until the next deploy imports one, which
 * is also what seeds it under `--keep-data`.
 */
async function runUpdate(args: ParsedArgs, opts: LocalEngineCommandOptions): Promise<void> {
  const env = opts.env ?? process.env;
  const dir = process.cwd();
  // A pin names a version on the DEFAULT release manager; a custom one's
  // versions are not the project's to pin.
  if (usesCustomReleaseManager(env)) {
    throw new Error(
      `${ENGINE_RELEASES_URL_ENV} names a custom release manager, and its engines are never pinned — ` +
        `so the pin was left as is.\nUnset it to move the pin, or keep deploying with it set to run ` +
        `that manager's latest.`,
    );
  }
  // An unusable pin is replaced like an unset one: the user asked for this write.
  const read = readPin(dir, { warn: (message) => warn(message, "local.pin-unusable") });
  // No package.json outside a project is a wrong directory, not a first pin:
  // refused before any request, so nothing is downloaded or created there.
  if (read === undefined && resolveProjectEntry(dir) === undefined) {
    throw new Error(
      `No package.json in ${dir}, and it is not a Xano SDK project, so there is no engine pin to move.\n` +
        `Run this from the project's root.`,
    );
  }
  // A project with no package.json reads like no pin: the write below creates one holding it.
  const current = typeof read === "object" || read === undefined ? null : read;

  const fetch = opts.fetch === undefined ? {} : { fetch: opts.fetch };
  const target = await requestedEngineVersion(args.engineVersion ?? "latest", opts, env, "update to");

  // Every outcome is said on stderr whatever stdout is, as `cache clear` says
  // its own: off a terminal the document alone left the log empty (E2E pass 29).
  if (current === target) {
    success(`Already on ${target} — nothing to update.`);
    if (isMachineOutput(args)) {
      writeJson({ from: current, to: target, changed: false, pinPath: join(dir, "package.json"), restarted: null });
    }
    return;
  }

  const acquired = await acquireEngine({
    spec: { kind: "release", version: target },
    env,
    ...fetch,
    ...(opts.platform === undefined ? {} : { platform: opts.platform }),
    ...(opts.arch === undefined ? {} : { arch: opts.arch }),
  });
  const pin = writePin(dir, target);
  const replaced = await restartMismatchedEngine({
    dir,
    acquired,
    env,
    ...(opts.run === undefined ? {} : { run: opts.run }),
    ...(opts.spawn === undefined ? {} : { spawn: opts.spawn }),
  });

  // A restart binds a fresh port, so a dev server pointed at the old one now
  // reaches nothing. Only a file that pointed at THIS engine follows it.
  const devEnv = replaced === undefined ? undefined : await repointDevEnvAfterRestart(dir, replaced);

  success(`Xano Engine ${current ?? "(unpinned)"} → ${target}`);
  info(pinWrittenText({ path: pin.path, version: target, created: pin.created, moved: current !== null }));
  if (replaced !== undefined) {
    info(`Restarted ${replaced.name} on ${target}. It starts empty — run your deploy to seed it.`);
    if (replaced.url !== replaced.previousUrl) {
      info("New Xano Engine URL:");
      link(replaced.url);
    }
    if (devEnv !== undefined) {
      detail(`Pointed ${devEnv.label} at the restarted engine (${devEnv.variable}) — restart your dev server to pick it up.`);
    }
  } else {
    detail(`No engine is running for this project; the next \`xanosdk deploy --local\` starts ${target}.`);
  }
  if (isMachineOutput(args)) {
    writeJson({
      from: current,
      to: target,
      changed: true,
      pinPath: pin.path,
      restarted: replaced?.name ?? null,
      url: replaced?.url ?? null,
    });
  }
}

/**
 * Follow a restarted engine in the project's dev env file, when that file
 * pointed at the engine's old URL. Never fails the update — the pin moved and
 * the engine is running; a file that cannot be written is warned about with the
 * URL to set by hand.
 */
async function repointDevEnvAfterRestart(dir: string, restarted: RestartedEngine): Promise<DevEnvSync | undefined> {
  if (restarted.previousUrl === undefined) return undefined;
  const { repointDevEnv } = await import("./dev-env-sync.js");
  try {
    return repointDevEnv(dir, restarted.previousUrl, restarted.url);
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err), "dev-env.sync-failed");
    return undefined;
  }
}

/**
 * `--version`'s value as a release version: `latest` asks the release manager,
 * anything else is normalized. One reading for every verb that takes it, so
 * `latest` names the same engine to `update` and to `cache clear`.
 */
async function requestedEngineVersion(
  requested: string,
  opts: LocalEngineCommandOptions,
  env: NodeJS.ProcessEnv,
  purpose: string,
): Promise<string> {
  if (requested.trim() !== "latest") {
    try {
      return normalizeEngineVersion(requested);
    } catch (err) {
      // A malformed version is fixed by retyping it: a usage failure.
      const clearing = purpose === "clear";
      throw new UsageError(
        (err instanceof Error ? err.message : String(err)) +
          (clearing ? " `cache clear` also takes `override`, or an override's `src-…` id from `cache list`." : ""),
        { hintFor: { command: "local", subcommand: clearing ? "cache" : "update" } },
      );
    }
  }
  const platform = resolveEnginePlatform(opts.platform ?? process.platform, opts.arch ?? process.arch);
  if (platform === undefined) {
    throw new Error(
      `There is no Xano Engine build for ${opts.platform ?? process.platform} ` +
        `${opts.arch ?? process.arch} — it runs on ${SUPPORTED_PLATFORMS.join(", ")} and nothing ` +
        `else, so there is no engine to ${purpose}. \`xanosdk deploy --ephemeral\` reaches an ephemeral from anywhere.`,
    );
  }
  const fetch = opts.fetch === undefined ? {} : { fetch: opts.fetch };
  return (await resolveEngineRelease({ platform, env, ...fetch })).version;
}

// ── cache ───────────────────────────────────────────────────────────────────

const CACHE_ACTIONS = ["list", "clear"] as const;

async function runCache(args: ParsedArgs, opts: LocalEngineCommandOptions): Promise<void> {
  const action = args.positionals[0];
  if (action === "list") {
    if (args.engineVersion !== undefined) {
      throw new UsageError(
        "`xanosdk local cache list` takes no `--version` — it lists every cached engine. " +
          "`cache clear --version <v>` is the one that takes it.",
        { helpFor: { command: "local", subcommand: "cache" } },
      );
    }
    if (args.legacyRuntime) {
      throw new UsageError(
        "`xanosdk local cache list` takes no `--legacy-runtime` — it lists the earlier runtime copy when there is one. " +
          "`cache clear --legacy-runtime` is the one that takes it.",
        { helpFor: { command: "local", subcommand: "cache" } },
      );
    }
    return runCacheList(args, opts);
  }
  if (action === "clear") return runCacheClear(args, opts);
  throw new UsageError(
    `\`xanosdk local cache\`: ${action === undefined || action === "" ? "no action given" : `unknown action "${action}"`} — ` +
      // Listed bare, as `unknownSubcommand` leaves the list to its help block: a
      // backticked `clear` here read as the correction already said, and the
      // "Did you mean: clear" line every other unknown verb prints was dropped.
      `it takes ${CACHE_ACTIONS.join(" or ")}.`,
    {
      helpFor: { command: "local", subcommand: "cache" },
      suggestion: action === undefined ? undefined : suggest(action, CACHE_ACTIONS),
    },
  );
}

/** Every cached entry: releases newest first, then overrides most recent first. */
function cachedEntries(env: NodeJS.ProcessEnv): EngineCacheEntry[] {
  return [...listReleaseEntries(env), ...listOverrideEntries(env)];
}

/**
 * Running engines per binary digest, through the records: the enumeration says
 * what is running, a record says which binary started it. An engine with no
 * record is foreign, and no binary here can be said to be its.
 */
function enginesByDigest(running: readonly LocalEngine[], env: NodeJS.ProcessEnv): Map<string, string[]> {
  const records = new Map(listEngineRecords(env).map((r) => [r.name, r] as const));
  const out = new Map<string, string[]>();
  for (const engine of running) {
    const digest = records.get(engine.name)?.engineDigest;
    if (digest === undefined) continue;
    out.set(digest, [...(out.get(digest) ?? []), engine.name]);
  }
  return out;
}

/** An entry's label in human output: its version, or `override (src-…)`. */
function entryLabel(entry: EngineCacheEntry): string {
  return entry.version ?? `override (${basename(entry.dir)})`;
}

async function runCacheList(args: ParsedArgs, opts: LocalEngineCommandOptions): Promise<void> {
  const env = opts.env ?? process.env;
  const entries = cachedEntries(env);
  // The old layout is never run, but it is disk this cache holds and that
  // `cache clear` removes — so it is listed, after everything that can run.
  const legacy = listLegacyCacheDirs(env);
  const runtime = runtimeRows(env);
  if (entries.length === 0 && legacy.length === 0 && runtime.length === 0) {
    if (isMachineOutput(args)) writeJson({ entries: [] });
    // An info line like every other "nothing here" answer, not bare stdout text.
    else info("No Xano Engine is cached — `xanosdk deploy --local` fetches one.");
    return;
  }
  // The engine list is a courtesy on this verb: an enumeration that fails still
  // leaves the sizes worth showing, so it is reported rather than fatal. With
  // only old-layout directories there is no binary to ask, and nothing on them.
  let running: LocalEngine[] = [];
  const binary = cachedEngine(env);
  if (binary !== undefined) {
    try {
      running = listEngines({ entry: binary, env, ...(opts.run === undefined ? {} : { run: opts.run }) });
    } catch (err) {
      warn(`Could not list running engines, so none are shown: ${(err as Error).message.split("\n")[0]}`, "local.list-failed");
    }
  }
  const using = enginesByDigest(running, env);
  // Every engine this tool runs, runs from the one unpacked runtime.
  const onRuntime = running.map((e) => e.name);
  const rows: LocalEngineCacheRow[] = [
    ...entries.map((entry) => ({
      version: entry.version ?? "override",
      source: entry.source,
      id: basename(entry.dir),
      bytes: diskBytes(entry.dir),
      engines: using.get(entry.digest) ?? [],
    })),
    ...legacy.map((dir) => ({
      version: "legacy",
      source: "legacy" as const,
      id: basename(dir),
      bytes: diskBytes(dir),
      engines: [],
    })),
    ...runtime.map((row) => (row.source === "runtime" ? { ...row, engines: onRuntime } : row)),
  ];
  if (isMachineOutput(args)) {
    writeJson({ entries: rows });
    return;
  }
  const s = stdoutStyle();
  // Columns padded to the widest row, as `profile list` does, and BEFORE
  // styling: the escape codes would otherwise count toward the width. Sizes are
  // right-aligned so their units line up.
  const labels = rows.map((row, i) =>
    i < entries.length
      ? entryLabel(entries[i]!)
      : row.source === "runtime"
        ? "unpacked runtime"
        : row.source === "legacy-runtime"
          ? // Its full path goes LAST: as the label it padded every row to its length.
            "earlier runtime copy"
          : `old layout (${row.id})`,
  );
  const sizes = rows.map((row) => formatBytes(row.bytes));
  const labelWidth = Math.max(0, ...labels.map((l) => l.length));
  const sizeWidth = Math.max(0, ...sizes.map((z) => z.length));
  const lines = rows.map((row, i) => {
    const on =
      row.engines.length > 0
        ? `  ${s.cyan(`running: ${row.engines.join(", ")}`)}`
        : row.source === "legacy-runtime"
          ? `  ${s.dim(row.id)}`
          : "";
    const size = sizes[i]!.padStart(sizeWidth);
    return `  ${s.bold(labels[i]!.padEnd(labelWidth))}  ${s.dim(size)}${on}`;
  });
  printHuman(lines.join("\n") + "\n");
  if (legacy.length > 0) {
    detail("Old-layout directories are never run — `xanosdk local cache clear` removes them.");
  }
  if (runtime.some((r) => r.source === "runtime")) {
    detail("The unpacked runtime is what the engines run from — `xanosdk local cache clear` removes it with the engines.");
  }
  if (runtime.some((r) => r.source === "legacy-runtime")) {
    detail(
      "An earlier runtime copy was left in your own cache directory by an earlier version, and nothing runs from it — " +
        "`xanosdk local cache clear --legacy-runtime` removes it.",
    );
  }
}

/** The unpacked runtime beside the cache, and any copy earlier versions left in the user's own cache directory. */
function runtimeRows(env: NodeJS.ProcessEnv): LocalEngineCacheRow[] {
  const rows: LocalEngineCacheRow[] = [];
  const home = engineRunHome(env);
  const bytes = diskBytes(home);
  if (bytes > 0) rows.push({ version: "runtime", source: "runtime", id: home, bytes, engines: [] });
  for (const dir of legacyRuntimeDirs(env)) {
    rows.push({ version: "legacy-runtime", source: "legacy-runtime", id: dir, bytes: diskBytes(dir), engines: [] });
  }
  return rows;
}

/**
 * Remove cached engines — all of them, or one version — stopping first every
 * engine running on a binary about to go.
 *
 * The stop runs through a binary this call KEEPS whenever one exists, and
 * through the doomed binary itself otherwise; either way before anything is
 * deleted, so no binary deletes itself mid-call. Clearing everything removes
 * every directory under `bin/`, including ones in a layout this version no
 * longer reads.
 */
async function runCacheClear(args: ParsedArgs, opts: LocalEngineCommandOptions): Promise<void> {
  const env = opts.env ?? process.env;
  if (args.legacyRuntime) return clearLegacyRuntime(args, env);
  const bin = localEngineBinDir(env);
  const requested = args.engineVersion?.trim();
  // `cache list` shows an operator-named engine as `override (src-…)`, so both
  // spellings clear it: `override` every such entry, `src-…` the one listed.
  const override = requested !== undefined && (requested === "override" || requested.startsWith("src-"));
  const version =
    requested === undefined || override ? undefined : await requestedEngineVersion(requested, opts, env, "clear");
  /** What this clear names, for the "not cached" and "Removed" lines. */
  const label = override ? (requested === "override" ? "the override engine" : requested) : version;

  // What is going: the entries (whose engines are stopped) and the directories
  // (what is removed). Clearing everything also takes anything else under bin/.
  let doomed: EngineCacheEntry[];
  let dirs: string[];
  if (version !== undefined || override) {
    const hits = override
      ? listOverrideEntries(env).filter((e) => requested === "override" || basename(e.dir) === requested)
      : [readEngineEntry({ version: version! }, env)].filter((e): e is EngineCacheEntry => e !== undefined);
    if (hits.length === 0) {
      // What IS cached, so a mistyped or already-cleared version has its real
      // neighbours beside it — on stderr whatever stdout is, and in the
      // document too: off a terminal the run said nothing at all (E2E pass 25).
      const cached = cachedEntries(env).map(entryLabel);
      // A cached version one slip from the one typed (`v0.1.41` for `v0.1.14`)
      // is named with the command that clears it (E2E pass 28). A tie
      // (`v0.1.15` beside `v0.1.14` and `v0.1.13`) names every one, as every
      // other did-you-mean does — `suggestions` in the document (E2E pass 29).
      const near =
        requested === "override" ? [] : suggestAll(label ?? requested ?? "", cached.filter((c) => !c.startsWith("override")));
      const clear = (v: string): string => `\`xanosdk local cache clear --version ${v}\``;
      info(
        `${requested === "override" ? "No override engine is cached" : `${label} is not cached`} — nothing to clear. ` +
          (cached.length === 0 ? "No engine is cached." : `Cached: ${cached.join(", ")}.`) +
          (near.length === 0 ? "" : ` Did you mean ${near.join(" or ")}? ${near.map(clear).join(" or ")}.`),
      );
      if (isMachineOutput(args)) {
        writeJson({
          stopped: [],
          removed: [],
          bytesFreed: 0,
          alreadyGone: true,
          cached,
          ...(near.length === 0 ? {} : { suggestion: near[0] }),
          ...(near.length > 1 ? { suggestions: near } : {}),
        });
      }
      return;
    }
    doomed = hits;
    dirs = hits.map((e) => e.dir);
  } else {
    doomed = cachedEntries(env);
    let names: string[] = [];
    try {
      names = readdirSync(bin);
    } catch {
      /* no bin/ at all: nothing is cached */
    }
    dirs = names.map((n) => join(bin, n));
  }
  // Clearing everything takes the runtime the engines unpacked too — hundreds
  // of MB the binaries alone never counted. A single version shares it with
  // the rest, so that clear leaves it — unless it is the LAST cached engine,
  // which would leave the runtime with nothing to run it.
  const last = label !== undefined && cachedEntries(env).every((e) => dirs.includes(e.dir));
  const runtime = label === undefined || last ? engineRunHome(env) : undefined;
  const runtimeBytes = runtime === undefined ? 0 : diskBytes(runtime);
  if (dirs.length === 0 && runtimeBytes === 0) {
    // On stderr whatever stdout is, as every other outcome of this verb.
    info("Nothing is cached — nothing to clear.");
    if (isMachineOutput(args)) writeJson({ stopped: [], removed: [], bytesFreed: 0, alreadyGone: true });
    return;
  }

  const stopped = stopEnginesOn(doomed, label === undefined, env, opts.run);
  // Only once nothing runs from it: an engine still up (one that did not stop,
  // one this tool did not start, or an enumeration that failed) keeps it.
  const stillRunning = runtimeBytes === 0 ? [] : enginesStillRunning(env, opts.run);

  // Each item measured as it goes, AFTER the stop: a stopped engine's data
  // leaves the runtime with it, so a size read earlier (or by `cache list`
  // while it ran) is not what this removes.
  const labelOf = (d: string): string => {
    const entry = doomed.find((e) => e.dir === d);
    return entry === undefined ? basename(d) : entryLabel(entry);
  };
  const items = dirs.map((d) => ({ name: labelOf(d), bytes: diskBytes(d) }));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  const removed = dirs.map((d) => basename(d));
  const runtimeRemoved = runtime !== undefined && runtimeBytes > 0 && stillRunning.length === 0;
  if (runtimeRemoved) {
    items.push({ name: "unpacked runtime", bytes: diskBytes(runtime) });
    rmSync(runtime, { recursive: true, force: true });
  }
  const bytesFreed = items.reduce((sum, item) => sum + item.bytes, 0);

  // The lines below go to stderr whatever stdout is, and the document is
  // written LAST: returning before them kept a `local.stop-failed` out
  // of `--json`'s warnings, and a piped clear that worked said nothing (E2E pass 28).
  for (const stop of stopped) {
    if (stop.stopped) success(`Stopped ${stop.name} — it ran on an engine being removed`);
    else warn(`${stop.name} was listed as running but did not stop. Stop it with \`xanosdk local stop ${stop.name}\`.`, "local.stop-failed");
  }
  const what = [
    ...(removed.length === 0 ? [] : [label ?? `${removed.length} cached engine director${removed.length === 1 ? "y" : "ies"}`]),
    ...(runtimeRemoved ? [last ? "the unpacked runtime, since no cached engine is left to run it" : "the unpacked runtime"] : []),
  ];
  if (what.length > 0) {
    success(`Removed ${what.join(" and ")} — freed ${formatBytes(bytesFreed)}`);
    // Per item, so the total can be checked against `cache list`'s rows.
    if (items.length > 1) for (const item of items) detail(`${item.name}: ${formatBytes(item.bytes)}`);
    if (runtimeRemoved && stopped.some((s) => s.stopped)) {
      detail(
        "The runtime also held the stopped engines' own data, which left with them — so its size here can be " +
          "smaller than `cache list` showed while they ran.",
      );
    }
  }
  if (runtimeBytes > 0 && !runtimeRemoved) {
    warn(
      `Kept the unpacked runtime (${formatBytes(runtimeBytes)}): ${stillRunning.join(", ")} ${stillRunning.length === 1 ? "is" : "are"} still running on it. ` +
        "Stop every engine (`xanosdk local stop --all`), then run `xanosdk local cache clear` again.",
      "local.runtime-kept",
    );
  }
  if (stopped.length > 0) {
    detail("The next `xanosdk deploy --local` fetches its engine again and restarts it.");
  }
  if (isMachineOutput(args)) {
    writeJson({ stopped: stopped.map((o) => o.name), removed, runtimeRemoved, items, bytesFreed, alreadyGone: false });
  }
}

/**
 * The engines still running under this tool's engine HOME, by name — or a
 * single placeholder when they cannot be listed, since "unknown" must keep the
 * runtime as surely as a running engine does. No binary to ask means nothing
 * this cache started can be running.
 */
function enginesStillRunning(env: NodeJS.ProcessEnv, run: EngineRun | undefined): string[] {
  const binary = cachedEngine(env);
  if (binary === undefined) return [];
  try {
    return listEngines({ entry: binary, env, ...(run === undefined ? {} : { run }) }).map((e) => e.name);
  } catch {
    return ["an engine that could not be listed"];
  }
}

/**
 * `cache clear --legacy-runtime`: the runtime copies earlier versions unpacked
 * in the user's OWN per-user cache directory, before engines ran under this
 * tool's HOME. Nothing runs from them, but they sit outside what this tool
 * owns, so they go only on this explicit flag and a yes.
 */
async function clearLegacyRuntime(args: ParsedArgs, env: NodeJS.ProcessEnv): Promise<void> {
  if (args.engineVersion !== undefined) {
    throw new UsageError("`--legacy-runtime` clears the earlier runtime copy, not a cached version — drop `--version`.", {
      hintFor: { command: "local", subcommand: "cache" },
    });
  }
  const dirs = legacyRuntimeDirs(env);
  if (dirs.length === 0) {
    // On stderr whatever stdout is: piped, the empty case said nothing a person
    // at the terminal could see (E2E pass 26), as a delete of a missing name says it.
    info("No earlier runtime copy is in your cache directory — nothing to clear.");
    if (isMachineOutput(args)) writeJson({ stopped: [], removed: [], bytesFreed: 0, alreadyGone: true });
    return;
  }
  const bytes = dirs.reduce((sum, d) => sum + diskBytes(d), 0);
  if (!args.yes) {
    const ok = await confirm(`Delete ${dirs.join(", ")} (${formatBytes(bytes)}), the runtime copy an earlier version left?`, {
      flag: "--yes",
      refusal: { details: { removed: [], bytesFreed: 0 }, ...yesRerun(args, "local cache clear --legacy-runtime") },
    });
    if (!ok) {
      info("Nothing was deleted.");
      return;
    }
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (isMachineOutput(args)) {
    writeJson({ stopped: [], removed: dirs, bytesFreed: bytes, alreadyGone: false });
    return;
  }
  success(`Removed the earlier runtime copy — freed ${formatBytes(bytes)}`);
}

/**
 * Stop, by name, every running engine whose record names one of `doomed`'s
 * binaries — or, when `everything` is going, every engine this tool started.
 *
 * Runs through a cached binary that is NOT being removed when there is one
 * (KTD7's order among the survivors), else through the first doomed one.
 *
 * Best-effort: the doomed binary may be the broken one this clear exists to
 * remove (tampered bytes, a failing `list`), and the error for exactly that case
 * sends the user here. So an enumeration that fails is warned about — with the
 * manual stop named — and a stop that throws counts as not stopped; neither
 * keeps the directories from going.
 */
function stopEnginesOn(
  doomed: readonly EngineCacheEntry[],
  everything: boolean,
  env: NodeJS.ProcessEnv,
  run: EngineRun | undefined,
): StopOutcome[] {
  const binary = cachedEngine(env, new Set(doomed.map((e) => e.dir))) ?? cachedEngine(env);
  if (binary === undefined) return [];
  const seam = { entry: binary, env, ...(run === undefined ? {} : { run }) };
  let running: LocalEngine[];
  try {
    running = listEngines(seam);
  } catch (err) {
    warn(
      `Could not list running engines, so none were stopped: ${(err as Error).message.split("\n")[0]}\n` +
        "  Any engine still running on a removed version keeps running — stop it with `xanosdk local stop <name>`.",
      "local.list-failed",
    );
    return [];
  }
  const records = new Map(listEngineRecords(env).map((r) => [r.name, r] as const));
  const digests = new Set(doomed.map((e) => e.digest));
  return running
    .filter((engine) => {
      const record = records.get(engine.name);
      return record !== undefined && (everything || digests.has(record.engineDigest));
    })
    .map((engine) => {
      try {
        return stopEngineNamed(engine.name, seam);
      } catch {
        return { name: engine.name, stopped: false, clearedProjects: [] };
      }
    });
}

/** `63.2 MB` — a size for a person, not a parser (`--json` carries the bytes). */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return unit === 0 ? `${n} B` : `${n.toFixed(1)} ${units[unit]}`;
}
