/**
 * Running a Xano Engine: start it, find the ones already running, stop them.
 *
 * This is the only module that spawns anything, and both seams it spawns
 * through are parameters rather than module-level mocks — the assertion that
 * matters on most of these paths is that a spawn did NOT happen (a tampered
 * cache entry, a refused url), and a call count is the only form of that
 * assertion the real implementation cannot explain away.
 *
 * Three things here are load-bearing and none of them are obvious:
 *
 * **The child's environment is constructed, not inherited.** The default is the
 * parent's, and at this moment the parent's env holds the credential that just
 * fetched the engine — a long-lived local server would then sit on the
 * developer's release token and everything beside it. So the child gets an
 * allowlist ({@link ENGINE_ENV_ALLOWLIST}) and nothing else.
 *
 * **HOME is constructed too, and that is not a detail.** The engine keeps its
 * run records, logs and runtime data under HOME's cache directory. Every child
 * gets the same one — {@link engineRunHome}, under the directory this feature
 * owns — because a child given a different HOME is invisible to every later
 * enumeration and every later stop, so reuse and teardown would both break
 * silently while everything still appeared to work.
 *
 * **The enumeration is the liveness oracle; a record is only a hint.** Local
 * staleness has three independent axes — the process is gone, the port now
 * belongs to something else, the bearer expired while the engine lives — and a
 * recorded pid answers none of them safely after a reboot. The engine's own
 * listing answers all three at once and re-emits a token for every engine it
 * still owns, which is why nothing on disk ever needs to hold one. Matching is
 * by NAME, and nothing here ever signals a pid: a reused pid is an unrelated
 * process, and stopping goes through the engine's own verb.
 *
 * Node-only, reached by a lazy import from the command layer.
 */
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fetchOrExplain, httpFailureError } from "../util/http.js";
import {
  listOverrideEntries,
  listReleaseEntries,
  readEngineEntry,
  type EngineCacheEntry,
  verifiedEngineExecutable,
} from "./local-engine-cache.js";
import { readPin } from "./local-engine-pin.js";
import { engineCacheDir, engineRunHome, localEngineHome } from "./local-engine-config.js";
import {
  assertLoopbackUrl,
  parseEngineHandshake,
  parseEngineListing,
  type LocalEngine,
} from "./local-engine-handshake.js";
import type { EngineFetch } from "./local-engine-release.js";
import {
  clearEngineRecordsNamed,
  listEngineRecords,
  type LocalEngineRecord,
} from "./local-engine-state.js";

/**
 * How long the start handshake has to arrive.
 *
 * Generous, because the engine brings up an embedded database before it speaks,
 * and bounded because a child that never speaks must fail rather than hang a
 * deploy forever.
 */
export const HANDSHAKE_TIMEOUT_MS = 60_000;

/**
 * The most stdout may hold before the handshake is called absent.
 *
 * The handshake is one small JSON object. Anything past this is a child that is
 * not speaking the protocol, and buffering it without limit is how a deploy
 * turns into an out-of-memory crash.
 */
export const MAX_HANDSHAKE_BYTES = 64 * 1024;

/** The most of the engine's own stderr kept for the boot-failure message. */
const MAX_STDERR_BYTES = 64 * 1024;

/**
 * Everything the child is allowed to see.
 *
 * HOME is listed but never passed through: {@link engineChildEnv} replaces it
 * with {@link engineRunHome} — see the module note. The rest is the platform
 * minimum a process needs to run at all. The
 * release credential is deliberately absent, and so is every hosted credential:
 * an engine has no use for either.
 */
export const ENGINE_ENV_ALLOWLIST: readonly string[] = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
];

/** The child a spawn seam hands back — the part of it this module touches. */
export interface EngineChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  /** Declared per event rather than generically, so nothing here needs `any`. */
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref(): void;
}

/** What {@link startEngine} asks a spawn for. Built here, asserted by the tests. */
export interface EngineSpawnOptions {
  detached: boolean;
  stdio: ("ignore" | "pipe")[];
  env: NodeJS.ProcessEnv;
}

/** The detached-spawn seam. */
export type EngineSpawn = (
  executable: string,
  args: readonly string[],
  options: EngineSpawnOptions,
) => EngineChild;

/** What a synchronous engine verb answers with. */
export interface EngineRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The seam the synchronous verbs (`list`, `stop`, `version`) go through. */
export type EngineRun = (
  executable: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => EngineRunResult;

const defaultSpawn: EngineSpawn = (executable, args, options) =>
  nodeSpawn(executable, [...args], { ...options, windowsHide: true });

const defaultRun: EngineRun = (executable, args, options) => {
  const result = spawnSync(executable, [...args], { ...options, encoding: "utf8", windowsHide: true });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

/**
 * Redact anything token-shaped out of text that is about to be written or
 * printed.
 *
 * The engine's own output was measured clean — no bearer, no sign-in key — but
 * "measured clean on one build" is not a property this side can keep, and the
 * never-print-the-bearer rule counts the log this tool writes and the tail it
 * prints as its own sinks. So the shapes are removed rather than trusted: a
 * JWT, a `key=` sign-in parameter, and a bearer header.
 */
function redactSecrets(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted]")
    .replace(/(\bkey=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/(\bBearer\s+)\S+/gi, "$1[redacted]");
}

/**
 * The environment the child gets: the allowlist, and only what the parent
 * actually had.
 *
 * A variable the parent does not set is not invented, so the child sees the
 * same absence the parent did rather than an empty string standing in for one.
 * PATH is the exception — a child with no PATH cannot find anything it shells
 * out to, and an empty one is the honest default.
 */
export function engineChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const built: NodeJS.ProcessEnv = {};
  for (const key of ENGINE_ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined) built[key] = value;
  }
  built.PATH = env.PATH ?? "";
  // The same HOME for every spawn, under the directory this feature owns — the
  // engine's logs and runtime data land there, not in the developer's cache.
  built.HOME = engineRunHome(env);
  return built;
}

/**
 * Where THIS tool keeps what an engine's launcher printed on stderr while
 * starting — under the cache root, never the project. Written only when it
 * printed something; the engine's own output is in {@link engineOwnLogs}.
 */
export function engineLogPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(localEngineHome(env), "logs", `${name}.log`);
}

/**
 * The directory the engine writes its own log to — one file per started
 * engine, the newest the last start: the `logs/` inside its data directory
 * under {@link engineCacheDir}. Found rather than spelled, so the name is the
 * engine's own; the cache directory itself before the engine has made one.
 */
export function engineOwnLogs(env: NodeJS.ProcessEnv = process.env): string {
  const cache = engineCacheDir(env);
  try {
    for (const entry of readdirSync(cache, { withFileTypes: true })) {
      const logs = join(cache, entry.name, "logs");
      if (entry.isDirectory() && existsSync(logs)) return logs;
    }
  } catch {
    /* no cache yet: the engine never got far enough to make one */
  }
  return cache;
}

/** What {@link startEngine} needs: a verified engine, a name, and the seams. */
export interface StartEngineOptions {
  /** The cache entry to run. Re-verified before the spawn, never spawned raw. */
  entry: EngineCacheEntry;
  /** The engine's name — the handle every later lookup and stop matches on. */
  name: string;
  env?: NodeJS.ProcessEnv;
  spawn?: EngineSpawn;
  /** Overridden only by tests, which drive the bound rather than waiting it out. */
  timeoutMs?: number;
  /** The engine's version (`v0.1.15`), when known; decides whether it is started with `--ttl 0`. */
  version?: string;
}

/** The first engine release that stops an `--ephemeral` engine after an hour unless given `--ttl`. */
const FIRST_TTL_RELEASE = [0, 1, 15] as const;

/**
 * Whether an engine of this version expires its ephemeral on a timer, and so
 * takes `--ttl`. An unknown or unparseable version is no: an engine that
 * predates the flag refuses to boot on it.
 */
export function engineExpiresEphemerals(version: string | undefined): boolean {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? "")?.slice(1).map(Number);
  if (parts === undefined) return false;
  for (let i = 0; i < 3; i++) if (parts[i] !== FIRST_TTL_RELEASE[i]) return parts[i]! > FIRST_TTL_RELEASE[i]!;
  return true;
}

/**
 * Start an engine and wait for it to announce itself.
 *
 * Resolves the moment a complete handshake parses — not on the child's exit —
 * so the child can be released and the CLI can exit while the engine keeps
 * serving. Every other outcome is a refusal: a boot failure surfaces the
 * engine's own tail, silence hits the time bound, and noise hits the byte
 * bound.
 *
 * `async` deliberately: the pre-spawn checks throw, and a caller awaiting a
 * start should not have to also wrap it in a try — every failure here is a
 * rejection.
 */
export async function startEngine(opts: StartEngineOptions): Promise<LocalEngine> {
  const env = opts.env ?? process.env;
  const spawn = opts.spawn ?? defaultSpawn;
  // The directory control AND a re-hash of the bytes, on the one call a spawn
  // goes through. Before anything is created, so a tampered entry refuses
  // without leaving a log file behind for an engine that never ran.
  const executable = verifiedEngineExecutable(opts.entry, env);

  const logPath = engineLogPath(opts.name, env);
  mkdirSync(join(localEngineHome(env), "logs"), { recursive: true, mode: 0o700 });
  mkdirSync(engineRunHome(env), { recursive: true, mode: 0o700 });
  // An earlier start's file removed up front: the mode is a property of THIS
  // file (created 0600 on the first write), and an append to a pre-existing
  // world-readable one would inherit its mode instead. Created only when the
  // launcher prints something — an empty file named in a failure sent the
  // reader to nothing.
  rmSync(logPath, { force: true });
  let launcherPrinted = false;
  // Where a failure's output is: the engine's own log, and what the launcher
  // printed when it printed anything.
  // Only what exists is named: an engine that could not create its own
  // directories has no log there, and a path to nothing sends the reader nowhere.
  const outputIsIn = (): string => {
    const own = engineOwnLogs(env);
    const where = [
      ...(existsSync(own) ? [`The engine's own log is the newest file in ${own}`] : []),
      ...(launcherPrinted ? [`What it printed while starting is in ${logPath}`] : []),
    ];
    return where.join("; ").replace(/; What/, "; what");
  };
  const checkOutput = (): string => {
    const where = outputIsIn();
    return where === "" ? "It left no log to check — re-run it." : `${where} — check it, then re-run.`;
  };

  const child = spawn(
    executable,
    // `--ephemeral` for a throwaway backend, `--detach` so the launcher prints
    // the handshake and exits while the engine keeps serving, `--name` so this
    // project's engine is findable by the one handle everything matches on.
    // `--ttl 0` because a project's engine is reused across deploys and holds
    // its data and static site: the default one-hour lifetime would delete both.
    ["--ephemeral", "--detach", "--name", opts.name, ...(engineExpiresEphemerals(opts.version) ? ["--ttl", "0"] : [])],
    {
      detached: true,
      // stdin ignored: nothing here answers a prompt, and an inherited stdin is
      // a detached process competing with the CLI for the terminal.
      stdio: ["ignore", "pipe", "pipe"],
      env: engineChildEnv(env),
    },
  );

  return new Promise<LocalEngine>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const timeoutMs = opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      fail(
        new Error(
          `The engine did not report itself started within ${Math.round(timeoutMs / 1000)}s.\n` +
            checkOutput(),
        ),
      );
    }, timeoutMs);

    function finish(engine: LocalEngine): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Released, not killed: the engine is the point, and the CLI is about to
      // exit out from under it.
      child.unref();
      resolve(engine);
    }

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The child this call spawned, on a handle it still holds — never a
      // recorded pid, which after a reboot belongs to somebody else.
      try {
        child.kill();
      } catch {
        /* already gone, which is the outcome anyway. */
      }
      reject(err);
    }

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
      if (stdout.length > MAX_HANDSHAKE_BYTES) {
        fail(
          new Error(
            `The engine printed too much output without reporting itself started.\n` +
              checkOutput(),
          ),
        );
        return;
      }
      // An incomplete object is the normal case mid-stream, so a parse failure
      // is silence. A COMPLETE one that does not validate is a refusal, which
      // is what separates the two reads below.
      try {
        JSON.parse(stdout.trim());
      } catch {
        return;
      }
      try {
        finish(parseEngineHandshake(stdout));
      } catch (err) {
        fail(err as Error);
      }
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = redactSecrets(String(chunk));
      if (stderr.length < MAX_STDERR_BYTES) stderr += text;
      try {
        appendFileSync(logPath, text, { mode: 0o600 });
        launcherPrinted = true;
      } catch {
        /* a log this side could not write is never the reason a deploy fails. */
      }
    });

    child.on("error", (err: Error) => {
      fail(
        new Error(
          `The engine could not be started: ${err.message}\n` +
            `Fetch a fresh copy with \`xanosdk local cache clear\`, then deploy again ` +
            `(\`xanosdk deploy --local\`).`,
        ),
      );
    });

    child.on("close", (code: number | null) => {
      // Deferred past the stream's own delivery: `close` is emitted
      // synchronously while the last stdout/stderr chunks are still queued, so
      // settling here immediately would report a boot failure with no tail and
      // would miss a handshake that had already been written.
      setImmediate(() => {
        if (settled) return;
        fail(new Error(bootFailure(opts.name, code, stderr.trim(), outputIsIn(), engineRunHome(env))));
      });
    });
  });
}

/**
 * A start that exited before its handshake, said once: the engine by name,
 * ONE exit status (the engine's own report of it when its output carries one —
 * the launcher's differed, and two read as two failures), its output, and a
 * cause only when the output shows it. "A name already taken" was said for
 * every exit, including a permission error its own log named. Exported for the
 * tests.
 */
export function bootFailure(name: string, code: number | null, tail: string, outputIsIn: string, runHome: string): string {
  const reported = /\bexit status \d+/i.test(tail);
  const head = `The engine ${name} exited${reported || code === null ? "" : ` (status ${code})`} instead of starting.`;
  const lines = tail.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  let cause: string;
  const denied = lines.find((l) => /permission denied|\bEACCES\b|operation not permitted|read-only file system/i.test(l));
  if (denied !== undefined) {
    // The directory it could not write: the nearest existing one above the
    // path its output names (`mkdir …/Library: permission denied` is its
    // PARENT refusing), else the engine's home — never one that does not exist.
    const named = /(\/[^\s:"']+)\s*:\s*(?:permission denied|operation not permitted|read-only file system)/i.exec(denied)?.[1];
    const dir = nearestExisting(named ?? join(runHome, "x"));
    cause =
      dir === undefined
        ? `It could not write its own files — make ${runHome} and everything under it writable (\`chmod -R u+w ${runHome}\`), then re-run.`
        : `It could not write under ${dir} — make it writable (\`chmod u+w ${dir}\`), then re-run.`;
  } else if (lines.some((l) => /already (?:in use|taken|running|exists)|address in use|\bEADDRINUSE\b/i.test(l))) {
    cause = `The name or port is already taken — stop the engine holding it with \`xanosdk local stop ${name}\`, then re-run.`;
  } else {
    const last = [...lines].reverse().find((l) => /\berror\b|failed|denied|cannot|refused|not found|no such/i.test(l));
    cause = last === undefined ? "Check it, then re-run." : `Its last error: ${last}`;
  }
  return `${head}${tail === "" ? "" : `\n${tail}`}\n${outputIsIn === "" ? "" : `${outputIsIn}. `}${cause}`;
}

/** The nearest directory above `path` that exists, short of the root — the one a failed create could not write into. */
function nearestExisting(path: string): string | undefined {
  // The filesystem root is never the answer: "make / writable" is no remedy.
  for (let dir = dirname(path); dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(dir)) return dir;
  }
  return undefined;
}

/**
 * The cached engine a verb runs from (KTD7): the project's pinned version when
 * it is cached, else the newest release version on this machine, else the most
 * recently fetched override.
 *
 * The pin leads so a project's verbs run the engine its deploys run. Releases
 * come next because they are what a bare `--local` runs; an override is
 * the fallback for a machine that has only ever been handed one. `exclude`
 * drops entries about to be deleted, so `cache clear` stops engines through a
 * binary it keeps whenever there is one.
 *
 * `undefined` rather than a throw: a machine with no cached engine has never
 * started one through this tool, and each caller answers that case in its own
 * words — the lifecycle verbs name what they could not do, the resolver
 * reports the engine as gone.
 *
 * Lives here rather than beside the verbs because the selector resolver needs
 * the same choice: an engine enumerated through a different binary than the one
 * `local list` would use is the same answer, but two copies of the rule
 * are two places for "which binary" to drift.
 */
export function cachedEngineEntry(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
  exclude: ReadonlySet<string> = new Set(),
): EngineCacheEntry | undefined {
  const keep = (e: EngineCacheEntry | undefined) => (e !== undefined && !exclude.has(e.dir) ? e : undefined);
  // Read quietly: a malformed pin is the deploy's to report, and here it only
  // means "no preference".
  const pin = readPin(cwd);
  if (typeof pin === "string") {
    const pinned = keep(readEngineEntry({ version: pin }, env));
    if (pinned !== undefined) return pinned;
  }
  return listReleaseEntries(env).find((e) => keep(e)) ?? listOverrideEntries(env).find((e) => keep(e));
}

/** What the synchronous verbs need: an engine to run, and the seam to run it through. */
export interface EngineCommandOptions {
  entry: EngineCacheEntry;
  env?: NodeJS.ProcessEnv;
  run?: EngineRun;
}

function runVerb(args: readonly string[], opts: EngineCommandOptions): EngineRunResult {
  const env = opts.env ?? process.env;
  const run = opts.run ?? defaultRun;
  return run(verifiedEngineExecutable(opts.entry, env), args, { env: engineChildEnv(env) });
}

/**
 * Every engine running on this machine, as the engine itself reports them.
 *
 * The liveness oracle. A non-zero status is a refusal rather than "none
 * running": reporting an unreachable enumeration as empty would start a second
 * engine beside one that is already serving.
 */
export function listEngines(opts: EngineCommandOptions): LocalEngine[] {
  return readListing(runVerb(["list", "--json"], opts));
}

/** The asynchronous seam {@link listEnginesAsync} goes through. */
export type EngineRunAsync = (
  executable: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<EngineRunResult>;

/** What {@link listEnginesAsync} takes: the synchronous verbs' options, with an async seam. */
export interface AsyncEngineCommandOptions {
  entry: EngineCacheEntry;
  env?: NodeJS.ProcessEnv;
  run?: EngineRunAsync;
  /** How long the enumeration may take. Defaults to {@link HANDSHAKE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * {@link listEngines} without blocking the event loop, for a long-lived process
 * that keeps answering while it enumerates. Bounded in time and in bytes like a
 * start, so a wedged binary cannot hold the caller forever or fill its memory.
 */
export async function listEnginesAsync(opts: AsyncEngineCommandOptions): Promise<LocalEngine[]> {
  const env = opts.env ?? process.env;
  const run = opts.run ?? boundedRun(opts.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  return readListing(await run(verifiedEngineExecutable(opts.entry, env), ["list", "--json"], { env: engineChildEnv(env) }));
}

function boundedRun(timeoutMs: number): EngineRunAsync {
  return (executable, args, options) =>
    new Promise((resolve, reject) => {
      const child = nodeSpawn(executable, [...args], { env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const giveUp = (why: string): void =>
        settle(() => {
          child.kill();
          reject(new Error(`The engine could not list what is running: ${why}.`));
        });
      const timer = setTimeout(() => giveUp(`it did not answer within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdout += String(chunk);
        if (stdout.length > MAX_HANDSHAKE_BYTES) giveUp("it printed more than a listing holds");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (!settled && stderr.length < MAX_STDERR_BYTES) stderr += String(chunk);
      });
      child.on("error", (err) => settle(() => reject(err)));
      child.on("close", (status) => settle(() => resolve({ status, stdout, stderr })));
    });
}

function readListing(result: EngineRunResult): LocalEngine[] {
  if (result.status !== 0) {
    throw new Error(
      `The engine could not list what is running` +
        (result.stderr.trim() === "" ? `.` : `: ${redactSecrets(result.stderr.trim())}`) +
        `\nRe-run, and if it happens again fetch a fresh copy with \`xanosdk local cache clear\`, ` +
        `then \`xanosdk deploy --local\`.`,
    );
  }
  return parseEngineListing(result.stdout);
}

/**
 * The engine's own version string, for reporting a running engine that is not
 * the cached one rather than silently reusing across the difference.
 */
/**
 * The one version token in an engine's `version` output.
 *
 * That output is a multi-line block — the version on its first line, then build
 * facts — and what is shown and recorded is one token: the first version-shaped
 * word of the first line (`v0.1.5`), else that whole first line. Undefined for
 * empty output. Shared so a recorded version and a reported one read alike.
 */
export function engineVersionToken(output: string): string | undefined {
  const first = output.split("\n")[0]!.trim();
  if (first === "") return undefined;
  return /\bv?\d+\.\d+\.\d+\S*/.exec(first)?.[0] ?? first;
}

export function engineVersion(opts: EngineCommandOptions): string {
  const result = runVerb(["version"], opts);
  if (result.status !== 0) {
    throw new Error(
      `The engine could not report its version.\n` +
        `Re-run with the engine's URL or an archive path on the flag to get a fresh one.`,
    );
  }
  return result.stdout.trim();
}

/**
 * How long the engine has to mint a login link.
 *
 * Short, because the engine is on this machine and the route does nothing but
 * sign a token — anything slower than this is an engine that is not answering,
 * and the caller is a person waiting on a browser.
 */
export const LOGIN_LINK_TIMEOUT_MS = 10_000;

/** The one-time login a client holding the bearer can mint. */
export interface EngineLoginLink {
  /**
   * The short-lived, single-use session token. NOT the engine's bearer — it is
   * the same class of thing the hosted impersonate returns, so it may be shown.
   */
  _ti: string;
  /** The builder url the ENGINE built for that token. Used as given, never rebuilt. */
  url: string;
}

/** What {@link mintEngineLoginLink} takes beyond the engine itself. */
export interface LoginLinkOptions {
  /** Ask for a read-only session. The engine mints a different token for one. */
  guest?: boolean;
  /**
   * The request seam, a parameter for the same reason the spawn seams are: on
   * the refusal paths the assertion that matters is that it was NEVER called.
   */
  fetch?: EngineFetch;
}

const defaultLoginFetch: EngineFetch = (url, init) =>
  fetchOrExplain(url, init, "open a Xano Engine", LOGIN_LINK_TIMEOUT_MS);

/**
 * Mint a one-time login for an engine the enumeration just handed over.
 *
 * The bearer comes from the caller's `engine` — i.e. from the enumeration —
 * because nothing on disk holds one. So this is a point where a live token is
 * about to leave the process, and both urls it touches are gated: the endpoint
 * BEFORE the request (loopback only — an engine bound to all interfaces really
 * does report a non-loopback host, and the endpoint is a separate field from
 * the base url), and the url that comes back before anything opens it, since
 * that url carries a session.
 *
 * The engine's answer is used as given rather than reassembled from a base url
 * and a token: the engine is the thing that knows where its own builder lives,
 * and rebuilding would be this side guessing at a route it does not own.
 */
export async function mintEngineLoginLink(
  engine: LocalEngine,
  opts: LoginLinkOptions = {},
): Promise<EngineLoginLink> {
  assertLoopbackUrl(engine.loginLinkEndpoint, "The engine's sign-in route");
  const doFetch = opts.fetch ?? defaultLoginFetch;
  const res = await doFetch(engine.loginLinkEndpoint, {
    method: "POST",
    headers: {
      // The enumeration's bearer, on a loopback url, and nowhere else.
      authorization: `Bearer ${engine.token}`,
      "content-type": "application/json",
    },
    // A body either way: the route reads one, and `{}` is the plain session.
    body: JSON.stringify(opts.guest === true ? { guest_read_only: true } : {}),
  });
  if (!res.ok) {
    const body = redactSecrets(await res.text().catch(() => ""));
    // 401 is the one status with a fix of its own: the engine is answering but
    // no longer accepts this bearer, which is what a restarted engine looks
    // like from here. The rest are reported with what the engine said.
    if (res.status === 401) {
      throw new Error(
        `The engine no longer accepts the credential it reported for "${engine.name}".\n` +
          `It was most likely restarted since it was listed — run \`xanosdk local list\` to ` +
          `see what is running, then try again.`,
      );
    }
    throw httpFailureError(`open a Xano Engine`, res, body);
  }
  const data = (await res.json().catch(() => ({}))) as { _ti?: unknown; url?: unknown };
  if (typeof data._ti !== "string" || data._ti === "" || typeof data.url !== "string" || data.url === "") {
    throw new Error(
      `The engine did not return a one-time sign-in (\`_ti\`) and a url for "${engine.name}".\n` +
        `That is not an engine this SDK knows how to drive — move to a current one with ` +
        `\`xanosdk local update\`.`,
    );
  }
  assertLoopbackUrl(data.url, "The sign-in the engine returned");
  return { _ti: data._ti, url: data.url };
}

/** What a record resolved against the enumeration turned out to be. */
export type EngineResolution =
  | { state: "live"; engine: LocalEngine }
  | { state: "stale" }
  | { state: "unusable"; reason: string };

/**
 * Reconcile one record against the enumeration.
 *
 * By NAME and nothing else. The record's url is a hint that may already be
 * wrong — a restarted engine binds a fresh ephemeral port — so the live
 * engine's own url and token are what come back, and the record's are ignored.
 *
 * `unusable` rather than `live` for a non-loopback engine: the loopback rule
 * protects the reuse arm exactly as it protects a fresh start, and this is the
 * point on the reuse arm before the token gets used.
 */
export function resolveRecordedEngine(
  record: LocalEngineRecord,
  running: readonly LocalEngine[],
): EngineResolution {
  const engine = running.find((e) => e.name === record.name);
  if (engine === undefined) return { state: "stale" };
  try {
    assertLoopbackUrl(engine.url, "The engine recorded for this project");
  } catch (err) {
    return { state: "unusable", reason: (err as Error).message };
  }
  return { state: "live", engine };
}

/** What one stop did: whether an engine went away, and whose records it cleared. */
export interface StopOutcome {
  name: string;
  /** Did the engine's own verb report stopping something? */
  stopped: boolean;
  /** The projects whose records named this engine, now cleared. */
  clearedProjects: string[];
}

/**
 * Stop one engine by name and clear every record that named it.
 *
 * Through the engine's own verb, never a signal. The records are cleared either
 * way: a name that was not running is exactly the stale-record case, and
 * leaving the row would keep a dead engine findable.
 */
export function stopEngineNamed(name: string, opts: EngineCommandOptions): StopOutcome {
  const result = runVerb(["stop", name], opts);
  return {
    name,
    stopped: result.status === 0,
    clearedProjects: clearEngineRecordsNamed(name, opts.env ?? process.env),
  };
}

/** What `stop --all` did, including what it deliberately left alone. */
export interface StopAllOutcome {
  stopped: StopOutcome[];
  /** Running engines no record on this machine claims. Listed, never touched. */
  foreign: string[];
  /**
   * Records, as read with the listing, that name an engine which was not
   * running. The only rows `stop --all` may clear beyond the ones it stopped: a
   * record written after the listing belongs to an engine started since.
   */
  stale: LocalEngineRecord[];
  /** What crashed engines left running, stopped — see {@link stopOrphanedEngineProcesses}. */
  orphans: OrphanSweep;
}

/**
 * Stop every engine this tool started, across every project on the machine.
 *
 * Deliberately NOT the engine's own `--all`: that would take down an engine
 * somebody started by hand, which this tool has no business stopping. So the
 * enumeration is partitioned against the records and each of ours is stopped by
 * name, with the rest reported as untouched rather than silently left out — a
 * developer who ran `stop --all` and still sees an engine needs to be told why.
 * "The rest" is the engines of this tool's own kind; an entry of a different kind
 * (see `parseEngineListing`) is not enumerated at all, so it is neither stopped
 * nor listed here.
 */
export function stopAllEngines(opts: EngineCommandOptions & Omit<OrphanSweepOptions, "env">): StopAllOutcome {
  const env = opts.env ?? process.env;
  // Records BEFORE the listing: an engine a record names was started before the
  // record, so it is in a listing taken after. Read the other way round, a deploy
  // landing between the two leaves a record that names no engine the listing saw.
  const records = listEngineRecords(env);
  const running = listEngines(opts);
  const ours = new Set(records.map((r) => r.name));
  const live = new Set(running.map((e) => e.name));
  const stale = records.filter((r) => !live.has(r.name));
  const stopped: StopOutcome[] = [];
  const foreign: string[] = [];
  for (const engine of running) {
    if (ours.has(engine.name)) stopped.push(stopEngineNamed(engine.name, opts));
    else foreign.push(engine.name);
  }
  // After ours are stopped: what a crashed engine left behind is visible to no
  // enumeration, so `stop --all` is the one command that can say it cleared it.
  return { stopped, foreign, stale, orphans: stopOrphanedEngineProcesses(opts) };
}

// ── orphans ────────────────────────────────────────────────────────────────

/**
 * One row of the machine's process table: the process, its parent, and its
 * command line.
 */
export interface MachineProcess {
  pid: number;
  ppid: number;
  command: string;
}

/** The process-table seam: every process on the machine, read now. */
export type ProcessTable = () => readonly MachineProcess[];

/**
 * The signal seam. `0` asks only whether the process exists. False when it
 * does not (or cannot be signalled), true when the signal was delivered.
 */
export type ProcessSignal = (pid: number, signal: NodeJS.Signals | 0) => boolean;

/** What a sweep needs beyond the environment: the seams, and how long to wait. */
export interface OrphanSweepOptions {
  env?: NodeJS.ProcessEnv;
  processes?: ProcessTable;
  signal?: ProcessSignal;
  /** How long stopped processes have to exit. Tests pass 0. */
  waitMs?: number;
}

/** What a sweep did: the processes that exited, and any that were signalled and did not. */
export interface OrphanSweep {
  stopped: number[];
  stillRunning: number[];
}

/**
 * The machine's process table, from `ps`. Empty where there is no `ps` (Windows)
 * or it fails: a sweep that cannot see the table finds nothing to stop, which is
 * the state it would otherwise report as "nothing was left behind".
 */
const defaultProcessTable: ProcessTable = () => {
  if (process.platform === "win32") return [];
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  return result.stdout.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m === null ? [] : [{ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }];
  });
};

const defaultSignal: ProcessSignal = (pid, signal) => {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

/**
 * The processes an engine started that outlived it.
 *
 * An engine runs helper processes of its own, and they keep their data under
 * {@link engineRunHome} — so each one's command line names that directory. A
 * live engine is their parent; an engine killed outright (`kill -9`, a crash)
 * is not there to stop them, they are re-parented, and no enumeration lists
 * them: `local list` and `stop --all` asked the engine, and the engine
 * that owned them is gone. So an orphan is a process whose command line names
 * the run home and whose parent is not a process run from {@link
 * localEngineHome} — not an engine, and not another of an engine's helpers.
 *
 * The one place this module reads a pid, and it is read off the table at the
 * moment of asking, never recorded: the module note's rule is against trusting
 * a pid that could have been reused, and a pid whose command line names this
 * tool's own directory right now is not that.
 */
export function findOrphanedEngineProcesses(opts: OrphanSweepOptions = {}): MachineProcess[] {
  const env = opts.env ?? process.env;
  const runHome = `${engineRunHome(env)}${sep}`;
  const home = `${localEngineHome(env)}${sep}`;
  const rows = (opts.processes ?? defaultProcessTable)();
  const byPid = new Map(rows.map((row) => [row.pid, row] as const));
  // An engine itself runs from the engine home (its cached binary) but not
  // from the run home, and may name the run home among its own arguments —
  // detached, its parent is not an engine either, so it is excluded by what it
  // runs, not by who started it.
  const isEngine = (row: MachineProcess): boolean => row.command.startsWith(home) && !row.command.startsWith(runHome);
  return rows.filter(
    (row) =>
      row.pid !== process.pid &&
      row.command.includes(runHome) &&
      !isEngine(row) &&
      !(byPid.get(row.ppid)?.command.includes(home) ?? false),
  );
}

/**
 * Stop every orphan {@link findOrphanedEngineProcesses} finds: a termination
 * signal, which lets each shut down its own children, then a bounded wait for
 * them to go. A process still there when the wait ends is reported, not
 * killed harder — its data directory is the engine's, and a clean shutdown is
 * the one that leaves it reusable.
 */
export function stopOrphanedEngineProcesses(opts: OrphanSweepOptions = {}): OrphanSweep {
  const signal = opts.signal ?? defaultSignal;
  const pids = findOrphanedEngineProcesses(opts)
    .map((row) => row.pid)
    .filter((pid) => signal(pid, "SIGTERM"));
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  let alive = pids.filter((pid) => signal(pid, 0));
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (alive.length > 0 && Date.now() < deadline) {
    Atomics.wait(pause, 0, 0, 100);
    alive = alive.filter((pid) => signal(pid, 0));
  }
  return { stopped: pids.filter((pid) => !alive.includes(pid)), stillRunning: alive };
}
