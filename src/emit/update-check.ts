/**
 * Best-effort "a newer @xano/sdk is on npm" notifier for the CLI.
 *
 * Runs only from the real `bin.ts` executable (never from the programmatic
 * `run()` the tests drive), so `run()` stays pure and network-free. The notice
 * goes to STDERR — stdout is a clean data channel (`export`/`compile` bundles),
 * so a nagline can never corrupt a piped artifact.
 *
 * Cheap by construction: the latest version is cached to
 * `~/.xanosdk/update-check.json` and only re-fetched once per {@link CHECK_INTERVAL_MS},
 * so almost every invocation is an offline cache read that adds no latency. The
 * one daily network call is bounded by {@link FETCH_TIMEOUT_MS} and swallows every
 * error — a slow, offline, or down registry must never delay or fail a command.
 *
 * Opt out with `XANOSDK_NO_UPDATE_CHECK` / `NO_UPDATE_NOTIFIER` (the de-facto
 * convention), and it stays silent under `CI` or when stderr is not a TTY so it
 * never spams logs. Node-only; never reachable from the browser-safe `index.ts`.
 */
import { envFlagSet, readEnvVar } from "../util/env.js";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "../util/atomic-write.js";
import { readPathEnvVar } from "../util/home-path.js";
import { registerSecret } from "../util/secrets.js";
import { serverMessage } from "../util/http.js";
import { readVersion } from "./cli.js";
import { compareSemver, parseSemver } from "./semver.js";
import { style, warn, blank } from "./ui.js";
import { noteRunWarning } from "./output.js";
import { projectSdkVersion } from "./project-sdk.js";

/**
 * The endpoint for `@xano/sdk`'s latest published manifest: the registry npm
 * itself would install from, so the version `upgrade` reports is one its npm
 * install can fetch. `XANOSDK_UPDATE_REGISTRY` (a full manifest URL) overrides it.
 */
export function registryUrl(): string {
  // Empty is unset: `XANOSDK_UPDATE_REGISTRY=""` is how a shell clears it, not a
  // registry named "" to be refused as "not an http(s) URL".
  const override = readEnvVar("XANOSDK_UPDATE_REGISTRY");
  if (override !== undefined) return override;
  return `${npmRegistry().replace(/\/+$/, "")}/@xano/sdk/latest`;
}

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/**
 * npm's configured registry for the `@xano` scope, by npm's own precedence:
 * the environment (`npm_config_registry`), then the project's `.npmrc`, the
 * user's (`$NPM_CONFIG_USERCONFIG`, else `~/.npmrc`) and the global one
 * (`$PREFIX/etc/npmrc`). A `@xano:registry` at any of them wins over a plain
 * `registry`, as it does for npm.
 */
export function npmRegistry(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const { fromEnv, configs } = npmConfig(env, cwd);
  for (const key of ["@xano:registry", "registry"]) {
    const value = (key === "registry" ? fromEnv("registry") : undefined) ?? configs.find((c) => c.has(key))?.get(key);
    if (value !== undefined && value !== "") return value;
  }
  return DEFAULT_REGISTRY;
}

/** npm's config sources, highest precedence first: `npm_config_*`, then the project, user and global `.npmrc`. */
function npmConfig(env: NodeJS.ProcessEnv, cwd: string): { fromEnv: (key: string) => string | undefined; configs: Map<string, string>[] } {
  const fromEnv = (key: string): string | undefined => {
    const value = env[`npm_config_${key}`] ?? env[`NPM_CONFIG_${key.toUpperCase()}`];
    return value === undefined || value === "" ? undefined : value;
  };
  const files = [projectNpmrc(cwd), fromEnv("userconfig") ?? join(homedir(), ".npmrc")];
  const prefix = fromEnv("prefix");
  if (prefix !== undefined) files.push(join(prefix, "etc", "npmrc"));
  return { fromEnv, configs: files.flatMap((file) => (file === undefined ? [] : [readNpmrc(file, env)])) };
}

/**
 * The `authorization` header npm would send to `url`, from the same config:
 * the credential scoped to the longest `//host/path/` prefix of the URL
 * (`:_authToken` as a bearer, `:_auth` or `:username` + `:_password` as basic),
 * else an unscoped `_authToken` / `_auth` for the default registry. Undefined
 * when none is configured. The value is a secret: it goes into the request and
 * nowhere else.
 */
export function npmAuthHeader(url: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const { fromEnv, configs } = npmConfig(env, cwd);
  const get = (key: string): string | undefined => {
    const value = fromEnv(key) ?? configs.find((c) => c.has(key))?.get(key);
    return value === undefined || value === "" ? undefined : value;
  };
  const parts = parsed.pathname.split("/").filter(Boolean);
  for (let n = parts.length; n >= 0; n--) {
    const nerf = `//${parsed.host}/${parts.slice(0, n).map((p) => `${p}/`).join("")}`;
    const header = credentialAt(nerf, get);
    if (header !== undefined) return header;
  }
  const defaultHost = new URL(npmRegistry(env, cwd)).host;
  return parsed.host === defaultHost ? credentialAt("", get) : undefined;
}

/** The header for the credential under `prefix` (`//host/path/:` keys, or the bare unscoped ones for ""). */
function credentialAt(prefix: string, get: (key: string) => string | undefined): string | undefined {
  const key = (name: string): string => (prefix === "" ? name : `${prefix}:${name}`);
  const token = get(key("_authToken"));
  registerSecret(token);
  if (token !== undefined) return `Bearer ${token}`;
  const auth = get(key("_auth"));
  registerSecret(auth);
  if (auth !== undefined) return `Basic ${auth}`;
  const user = get(key("username"));
  const password = get(key("_password"));
  registerSecret(password);
  if (user !== undefined && password !== undefined) {
    return `Basic ${Buffer.from(`${user}:${Buffer.from(password, "base64").toString("utf8")}`).toString("base64")}`;
  }
  return undefined;
}

/** The `.npmrc` beside the nearest `package.json` at or above `cwd` — npm's project config. */
function projectNpmrc(cwd: string): string | undefined {
  let dir = cwd;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return join(dir, ".npmrc");
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** An `.npmrc`'s `key=value` lines, `${VAR}` expanded as npm does; empty when unreadable. */
function readNpmrc(file: string, env: NodeJS.ProcessEnv): Map<string, string> {
  const out = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (m === null) continue;
    const value = m[2]!.replace(/^(["'])(.*)\1$/, "$2").replace(/\$\{([^}]+)\}/g, (_, name: string) => env[name] ?? "");
    out.set(m[1]!, value);
  }
  return out;
}

/**
 * Whether {@link registryUrl} is an http(s) URL at all. `XANOSDK_UPDATE_REGISTRY`
 * set to `notaurl` or `file:///etc/passwd` never reaches a registry — `fetch`
 * refuses it before any network — and "could not reach … check your
 * connection" sent the reader to a network that works.
 */
export function registryUrlIsHttp(): boolean {
  try {
    const { protocol } = new URL(registryUrl());
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Cache location (overridable for tests): `~/.xanosdk/update-check.json`. */
function cachePath(): string {
  return readPathEnvVar("XANOSDK_UPDATE_CACHE") ?? join(homedir(), ".xanosdk", "update-check.json");
}

/**
 * Re-hit the registry at most once an hour; otherwise serve the cached answer.
 * Short by design — we publish often during rapid prototyping, so a stale nudge
 * should never lag a release by more than an hour.
 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Bound the registry fetch so a stalled endpoint can't hang the CLI. */
const FETCH_TIMEOUT_MS = 2_000;

/**
 * The same bound for the EXPLICIT check (`xanosdk upgrade`), deliberately longer.
 *
 * Two seconds is right for a courtesy nobody asked for — a nudge that misses its
 * window costs nothing and the user gets it next run. An explicit check has no
 * next run: giving up at two seconds on a slow link turns "you are up to date"
 * into "I could not tell", for a question the user is waiting on the answer to.
 */
const CHECK_TIMEOUT_MS = 10_000;

interface Cache {
  /**
   * The registry URL the answer came from. A cache is only ever read back for
   * the SAME registry: one written by a check against a mirror or a test stub
   * (`XANOSDK_UPDATE_REGISTRY`) must not nag later runs against the real one
   * about a version that registry never published. A cache without it predates
   * the key and is treated as absent.
   */
  registry: string;
  /** The `latest` dist-tag version last seen on the registry. */
  latest: string;
  /** Epoch ms of that fetch — drives the {@link CHECK_INTERVAL_MS} staleness gate. */
  checkedAt: number;
}

/** An available upgrade: what's installed vs. what npm's `latest` tag points at. */
export interface UpdateNotice {
  current: string;
  latest: string;
}

/**
 * Compare two `x.y.z[-pre.n]` versions, returning true when `candidate` is a
 * strict upgrade over `current`. Precedence itself lives in `semver.ts`, which
 * the toolchain loader's peer-range check reads too — one implementation, so
 * the two cannot drift. Unparseable input returns false: we never nag on a
 * version we can't reason about (a git build, `readVersion()`'s `"unknown"`).
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  return compareSemver(a, b) > 0;
}

function readCache(): Cache | undefined {
  const path = cachePath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Cache>;
    if (
      parsed.registry === registryUrl() &&
      typeof parsed.latest === "string" &&
      // A cache written before the registry's answer was validated can hold
      // anything; one that is not a version answers nothing.
      parseSemver(parsed.latest) !== null &&
      typeof parsed.checkedAt === "number"
    ) {
      return { registry: parsed.registry, latest: parsed.latest, checkedAt: parsed.checkedAt };
    }
  } catch {
    /* corrupt cache — treat as absent and re-fetch */
  }
  return undefined;
}

function writeCache(cache: Cache): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    atomicWrite(path, JSON.stringify(cache, null, 2) + "\n");
  } catch {
    /* an unwritable cache just means we re-check next run — never fatal */
  }
}

/** Fetch npm's `latest` version, or null on any failure (offline, timeout, 4xx/5xx). */
async function fetchLatest(timeoutMs: number = FETCH_TIMEOUT_MS): Promise<string | null> {
  const got = await fetchLatestOrWhy(timeoutMs);
  return "latest" in got ? got.latest : null;
}

/**
 * The same fetch, keeping WHY it failed: `answered` when the registry replied
 * with something other than a version (an error status, or a body that is not
 * one) — described through the shared formatter, so an HTML error page shows
 * its title — and nothing when it could not be reached at all. "Could not
 * reach" for a registry that answered 500 sends the reader to check a network
 * that works.
 */
async function fetchLatestOrWhy(timeoutMs: number): Promise<{ latest: string } | { answered?: string; refused?: RegistryRefusal }> {
  // Never handed to `fetch`: the notifier stays silent on it, and the explicit
  // check refuses it before calling here.
  if (!registryUrlIsHttp()) return {};
  // The credential npm itself would send: a private registry or a scoped
  // mirror answers 401 to an anonymous read that `npm view` makes signed.
  const authorization = npmAuthHeader(registryUrl());
  let res: Response;
  try {
    res = await fetch(registryUrl(), {
      headers: { accept: "application/json", ...(authorization === undefined ? {} : { authorization }) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {};
  }
  if (res.status === 401 || res.status === 403) {
    return { answered: `HTTP ${res.status}`, refused: authorization === undefined ? "no-credential" : "credential" };
  }
  let text = "";
  try {
    text = await res.text();
  } catch {
    /* the status alone still says it answered */
  }
  const said = serverMessage(text);
  if (!res.ok) return { answered: `HTTP ${res.status}${said === undefined ? "" : ` — ${said}`}` };
  let version: unknown;
  try {
    version = (JSON.parse(text) as { version?: unknown }).version;
  } catch {
    /* fall through: an answer, but not a version */
  }
  // Only a semver counts. Any other string compared as "not newer", so it was
  // reported as "you are on the latest", printed as `latest`, and cached for
  // the notifier — an answer built on a value that is not a version at all.
  if (typeof version === "string" && parseSemver(version) !== null) return { latest: version };
  if (typeof version === "string") {
    const shown = version.length > 40 ? `${version.slice(0, 40)}…` : version;
    return { answered: `a version field that is not a version (${JSON.stringify(shown)})` };
  }
  // Dashes, not parentheses: the caller already wraps this in a sentence, and
  // "(a response with no version (an HTML page …))" nests two deep.
  return { answered: `a body that holds no version${said === undefined ? "" : ` — ${said}`}` };
}

/**
 * Set when a command has already spoken about versions itself, so the end-of-run
 * nudge would only repeat or contradict it.
 *
 * Process-local rather than an env var: `XANOSDK_NO_UPDATE_CHECK` is the USER's
 * control, and writing to it from inside a command both overloads a documented
 * opt-out as an internal channel and leaks the setting into every child process
 * we spawn afterwards.
 */
let noticeSuppressed = false;

/** Silence the end-of-run nudge for the remainder of this process. */
export function suppressUpdateNotice(): void {
  noticeSuppressed = true;
}

/** True when the user, the environment, or the running command turned the notifier off. */
function disabled(): boolean {
  return Boolean(
    noticeSuppressed ||
      envFlagSet("XANOSDK_NO_UPDATE_CHECK") ||
      envFlagSet("NO_UPDATE_NOTIFIER") ||
      process.env.CI,
  );
}

/**
 * Resolve whether an upgrade is available, consulting (and refreshing) the cache.
 * Returns null when up to date, disabled, or the version can't be determined.
 * `force` bypasses the environment/TTY gates for tests. Never throws.
 */
export async function resolveUpdateNotice(opts?: {
  current?: string;
  force?: boolean;
}): Promise<UpdateNotice | null> {
  if (!opts?.force && disabled()) return null;
  const current = opts?.current ?? readVersion();
  if (current === "unknown") return null; // nothing to compare against

  const cache = readCache();
  let latest = cache?.latest;
  const now = Date.now();
  if (!cache || now - cache.checkedAt > CHECK_INTERVAL_MS) {
    const fetched = await fetchLatest();
    if (fetched) {
      latest = fetched;
      writeCache({ registry: registryUrl(), latest: fetched, checkedAt: now });
    }
    // On a failed fetch we fall back to the (stale) cached `latest`, if any —
    // a transient outage shouldn't suppress a notice we already know about.
  }

  return latest && isNewer(latest, current) ? { current, latest } : null;
}

/** A 401/403 from the registry: to the credential npm's config supplied, or to a read that carried none. */
export type RegistryRefusal = "credential" | "no-credential";

/**
 * What an EXPLICIT check found — four states, where the notifier has two.
 *
 * {@link resolveUpdateNotice} answers with `UpdateNotice | null`, and that `null`
 * means four different things: up to date, notifier disabled, local version
 * unresolvable, or the fetch failed. A notifier is right to collapse them — the
 * response to all four is to say nothing. A command cannot: reporting "up to
 * date" for a check that never reached the registry is a confident wrong answer
 * to the one question the user asked.
 */
export type CheckResult =
  | { status: "current"; current: string; latest: string }
  | { status: "available"; current: string; latest: string }
  /**
   * The installed version is NEWER than the latest published one — a
   * prerelease, a linked checkout, or a release not yet on npm. Not an
   * upgrade, and not "current" either: installing `latest` would downgrade.
   */
  | { status: "ahead"; current: string; latest: string }
  | { status: "unknown"; reason: "local-version" }
  /** `answered` describes what the registry replied with; absent when it was never reached. */
  | { status: "unknown"; reason: "registry"; answered?: string; refused?: RegistryRefusal }
  /** `XANOSDK_UPDATE_REGISTRY` is not an http(s) URL, so no registry was asked. */
  | { status: "unknown"; reason: "registry-url" };

/**
 * Resolve, live, whether a newer `@xano/sdk` is published.
 *
 * Three deliberate differences from {@link resolveUpdateNotice}, each because
 * this one answers a question someone typed:
 *
 *   • **No environment gates.** `CI`, `NO_UPDATE_NOTIFIER` and
 *     `XANOSDK_NO_UPDATE_CHECK` silence the nudge; they must not silence an
 *     answer, and CI is exactly where a scripted check runs.
 *   • **The cache is written, never read.** An answer served from a 59-minute-old
 *     cache is an answer to a different question. Writing it still leaves the
 *     notifier better informed than it found it.
 *   • **A failed fetch is `unknown`, not a stale fallback.** The notifier falls
 *     back to the cached `latest` so an outage can't suppress a nudge it already
 *     knows about. Here the caller has to be able to tell "no" from "I don't know".
 */
export async function checkForUpgrade(opts?: { current?: string }): Promise<CheckResult> {
  const current = opts?.current ?? readVersion();
  // A git build or a broken install: there is no version to compare against, and
  // guessing one would be worse than saying so. Returned BEFORE the fetch — a
  // round-trip whose result can't be used is pure latency.
  if (current === "unknown") return { status: "unknown", reason: "local-version" };
  if (!registryUrlIsHttp()) return { status: "unknown", reason: "registry-url" };

  const got = await fetchLatestOrWhy(CHECK_TIMEOUT_MS);
  if (!("latest" in got)) {
    return {
      status: "unknown",
      reason: "registry",
      ...(got.answered === undefined ? {} : { answered: got.answered }),
      ...("refused" in got && got.refused !== undefined ? { refused: got.refused } : {}),
    };
  }
  const latest = got.latest;

  writeCache({ registry: registryUrl(), latest, checkedAt: Date.now() });
  const status = isNewer(latest, current) ? "available" : isNewer(current, latest) ? "ahead" : "current";
  return { status, current, latest };
}

/**
 * Whether this CLI is a project-local dependency or a global install — so the
 * nudge suggests the matching upgrade command. We resolve `@xano/sdk` from
 * the user's CWD: if their project depends on it the resolve succeeds (a project-local
 * `xanosdk upgrade` is right); if it doesn't, the running CLI must be the global
 * install, so `-g` is right. Dependency-free and spawn-free (no `npm root -g`).
 * `XANOSDK_INSTALL_MODE` overrides it (tests, or a user who wants to pin the
 * suggestion). Any unexpected error falls back to `global` — the safe default,
 * since suggesting `-g` to a local-dep user is a no-op they'll notice, whereas
 * suggesting a project upgrade to a global user would wrongly add a stray project dependency.
 */
export function detectInstallMode(): "global" | "local" {
  const override = readEnvVar("XANOSDK_INSTALL_MODE")?.trim();
  if (override === "global" || override === "local") return override;
  try {
    const requireFromCwd = createRequire(join(process.cwd(), "package.json"));
    // A runner can put its own temporary copy on the resolution path
    // (`pnpm dlx` does): resolving that copy is not a project install.
    return packageRunnerOf(requireFromCwd.resolve("@xano/sdk/package.json")) === undefined ? "local" : "global";
  } catch {
    return "global";
  }
}

/** A package runner that fetches a temporary copy of a package to run it. */
export type PackageRunner = "npx" | "pnpm dlx" | "yarn dlx" | "bunx";

/**
 * The package runner whose temporary copy `path` lies in, or undefined for an
 * installation: `npx`/`npm exec` (`_npx`), `pnpm dlx` (`dlx`), `yarn dlx`
 * (`dlx-<pid>`), `bunx` (`bunx-…`).
 */
export function packageRunnerOf(path: string): PackageRunner | undefined {
  for (const seg of path.split(/[\\/]/)) {
    if (seg === "_npx") return "npx";
    if (seg === "dlx") return "pnpm dlx";
    if (/^dlx-\d+$/.test(seg)) return "yarn dlx";
    if (seg.startsWith("bunx-")) return "bunx";
  }
  return undefined;
}

/** Whether `path` lies in a package runner's temporary copy rather than an installation. */
export function isPackageRunnerPath(path: string): boolean {
  return packageRunnerOf(path) !== undefined;
}

/** The package runner this CLI is running from a temporary copy of, if any (see {@link packageRunnerOf}). */
export function runFromPackageRunner(): PackageRunner | undefined {
  return packageRunnerOf(fileURLToPath(import.meta.url));
}

/**
 * The line that upgrades an install of the given kind.
 *
 * A local install is pointed at `xanosdk upgrade`, never a raw npm line: a bare
 * `npm i -D` would move an SDK kept in `dependencies` into `devDependencies`
 * and write a caret that pins the `0.0.x` line, both of which `upgrade`
 * reconciles (it picks the save flag from the block the SDK already sits in).
 */
export function upgradeCommand(mode: "global" | "local"): string {
  return mode === "global" ? "npm i -g @xano/sdk@latest" : "xanosdk upgrade";
}

/**
 * What the nudge compares `latest` against: what `xanosdk upgrade` would act on.
 * In a project with `@xano/sdk` installed that is the PROJECT's version —
 * comparing the running binary instead nudged a global CLI behind a current
 * project on every run, and `upgrade` (which upgrades the project) could never
 * clear it. A different running version is kept as `cli`, for the case where
 * the CLI itself is what is behind.
 */
export function nudgeBaseline(): { current: string; cli?: string } {
  const running = readVersion();
  if (detectInstallMode() !== "local") return { current: running };
  const project = projectSdkVersion(process.cwd());
  return project === undefined || project === running ? { current: running } : { current: project, cli: running };
}

/** The nudge for `latest` against {@link nudgeBaseline}, or null when nothing is behind it. */
function nudgeFor(latest: string): { message: string; remedy: string } | null {
  const { current, cli } = nudgeBaseline();
  if (current === "unknown") return null;
  if (isNewer(latest, current)) {
    // `xanosdk upgrade` for every install: it runs `npm i -g` itself for a global
    // one, and it is the command `upgrade --check` names first.
    return { message: `A new @xano/sdk is available: ${style.dim(current)} → ${style.green(latest)}`, remedy: "update: xanosdk upgrade" };
  }
  if (cli !== undefined && isNewer(latest, cli)) {
    return {
      message: `This project's @xano/sdk ${current} is current, but the CLI you ran is ${style.dim(cli)} (latest ${style.green(latest)}) — your global CLI is older`,
      remedy: "update: npm i -g @xano/sdk@latest",
    };
  }
  return null;
}

/** Print the two-line upgrade nudge to stderr, styled but color-safe. */
export function printUpdateNotice(notice: UpdateNotice): void {
  blank();
  warn(`A new @xano/sdk is available: ${style.dim(notice.current)} → ${style.green(notice.latest)}`, "update.available", [
    `update: xanosdk upgrade`,
  ]);
}

/**
 * A machine-output run's nudge: into its document's `warnings[]` rather than a
 * banner printed after that document. Called at the start of the run, so a
 * document written by any command carries it; read from the cache alone, so
 * the run waits on no registry fetch. The end-of-run banner is suppressed.
 * The same gates as the banner: off in CI, opted out, or with no terminal.
 */
export function routeUpdateNoticeToDocument(): void {
  try {
    if (disabled() || process.stderr.isTTY !== true) return;
    suppressUpdateNotice();
    const latest = readCache()?.latest;
    const nudge = latest === undefined ? null : nudgeFor(latest);
    if (nudge !== null) noteRunWarning("update.available", `${stripAnsi(nudge.message)}\n${nudge.remedy}`);
  } catch {
    /* a notifier must never break the CLI */
  }
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Whether the run that is now ending exited cleanly.
 *
 * A command can RESOLVE and still have failed: `validate` sets exit 2 on a
 * round-trip mismatch, `deploy` sets 3 when the static upload fails, and both
 * return normally afterwards. The nudge is gated on the code for the same reason
 * the bin's catch skips it entirely — "a newer version is available" under a
 * failed command is noise at the exact moment the user is reading what broke.
 */
export function runExitedClean(code: number | string | undefined = process.exitCode): boolean {
  return code === undefined || code === 0;
}

/**
 * Best-effort end-of-run hook: notify iff an upgrade is available, the run
 * exited clean, and the notifier is enabled (interactive, non-CI, not opted
 * out). Swallows everything so it can never turn a successful command into a
 * failure.
 */
export async function maybeNotifyUpdate(): Promise<void> {
  try {
    if (disabled() || process.stderr.isTTY !== true || !runExitedClean()) return;
    const { current, cli } = nudgeBaseline();
    // Resolved against the oldest of the two, so the cache is refreshed whenever either could be behind.
    const notice = await resolveUpdateNotice({ current: cli !== undefined && isNewer(current, cli) ? cli : current });
    const nudge = notice === null ? null : nudgeFor(notice.latest);
    if (nudge !== null) {
      blank();
      warn(nudge.message, "update.available", [nudge.remedy]);
    }
  } catch {
    /* a notifier must never break the CLI */
  }
}
