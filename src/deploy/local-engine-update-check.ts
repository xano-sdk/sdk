/**
 * "Is there a newer engine than the pin" — answered cheaply, and what to do about it.
 *
 * Shaped like `src/emit/update-check.ts`: the newest published engine per
 * platform is cached in `<local-engine home>/latest.json` and re-asked at most
 * once per {@link UPDATE_CHECK_TTL_MS}, the whole lookup (every page of it) is
 * bounded by {@link UPDATE_CHECK_TIMEOUT_MS}, a failed lookup is not retried
 * for {@link UPDATE_CHECK_FAILURE_BACKOFF_MS}, and every failure is swallowed —
 * the check must never fail or noticeably slow a deploy. `XANOSDK_NO_UPDATE_CHECK` /
 * `NO_UPDATE_NOTIFIER` turn it off.
 *
 * The same file remembers, per project on this machine, the version the
 * developer last declined, so a declined version is noticed once per deploy
 * and never prompted for again; a newer release asks afresh.
 *
 * The branching is {@link decideUpdate}, a pure function, and the words are
 * {@link updatePromptText} / {@link updateNoticeText}, so the deploy and
 * `local-engine update` say the same thing. Node-only.
 */
import { envFlagSet } from "../util/env.js";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWrite } from "../util/atomic-write.js";
import { compareSemver, parseSemver } from "../emit/semver.js";
import { localEngineHome, type EnginePlatform } from "./local-engine-config.js";
import type { EngineFetch } from "./local-engine-release.js";
import { normalizeEngineVersion, resolveEngineRelease } from "./local-engine-releases.js";

/** Re-ask the release manager at most once an hour; otherwise answer from the cache. */
export const UPDATE_CHECK_TTL_MS = 60 * 60 * 1000;

/** Bound on the whole lookup, all pages included, so a stalled release manager cannot hold up a deploy. */
export const UPDATE_CHECK_TIMEOUT_MS = 3_000;

/** After a failed lookup, answer from the cache (or not at all) for this long before asking again. */
export const UPDATE_CHECK_FAILURE_BACKOFF_MS = 15 * 60 * 1000;

/** One platform's entry: the last answer and when it was learned, and when a lookup last failed (epoch ms). */
interface PlatformEntry {
  version?: string;
  checkedAt?: number;
  failedAt?: number;
}

/** What `latest.json` holds. Every field optional: the file is read defensively. */
interface LatestFile {
  /** Newest published engine per platform, when that was learned, and the last failed lookup. */
  platforms?: Partial<Record<EnginePlatform, PlatformEntry>>;
  /** The version last declined, keyed by the project's resolved absolute path. */
  declined?: Record<string, string>;
}

const latestPath = (env: NodeJS.ProcessEnv) => join(localEngineHome(env), "latest.json");

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The cache file, or `{}` when it is missing, unreadable, or not the shape written here. */
function readLatest(env: NodeJS.ProcessEnv): LatestFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(latestPath(env), "utf8"));
    if (!isObject(parsed)) return {};
    const out: LatestFile = {};
    if (isObject(parsed.platforms)) {
      out.platforms = {};
      for (const [platform, entry] of Object.entries(parsed.platforms)) {
        if (!isObject(entry)) continue;
        const kept: PlatformEntry = {};
        if (typeof entry.version === "string" && typeof entry.checkedAt === "number") {
          kept.version = entry.version;
          kept.checkedAt = entry.checkedAt;
        }
        if (typeof entry.failedAt === "number") kept.failedAt = entry.failedAt;
        if (Object.keys(kept).length > 0) out.platforms[platform as EnginePlatform] = kept;
      }
    }
    if (isObject(parsed.declined)) {
      out.declined = {};
      for (const [key, v] of Object.entries(parsed.declined)) if (typeof v === "string") out.declined[key] = v;
    }
    return out;
  } catch {
    return {}; // missing or corrupt — treated as absent
  }
}

/** Write the cache owner-only (dir 0700, file 0600). Throws; callers decide whether that matters. */
function writeLatest(env: NodeJS.ProcessEnv, file: LatestFile): void {
  mkdirSync(localEngineHome(env), { recursive: true, mode: 0o700 });
  atomicWrite(latestPath(env), JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

/** True when the developer or the environment turned the check off. */
function optedOut(env: NodeJS.ProcessEnv): boolean {
  return envFlagSet("XANOSDK_NO_UPDATE_CHECK", env) || envFlagSet("NO_UPDATE_NOTIFIER", env);
}

/**
 * `lookup` under one overall deadline of `timeoutMs`: every request it makes
 * through the given `fetch` shares one abort signal, and the whole lookup is
 * also raced against a timer, so neither a slow page-by-page walk nor a seam
 * that ignores the signal can outlast the bound.
 */
async function withDeadline<T>(
  fetch: EngineFetch | undefined,
  timeoutMs: number,
  lookup: (fetch: EngineFetch) => Promise<T>,
): Promise<T> {
  const base: EngineFetch = fetch ?? ((url, init) => globalThis.fetch(url, init));
  const deadline = new AbortController();
  const signalled: EngineFetch = (url, init) =>
    base(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("engine update check timed out");
      deadline.abort(err);
      reject(err);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([lookup(signalled), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface LatestKnownVersionOptions {
  platform: EnginePlatform;
  env?: NodeJS.ProcessEnv;
  /** The network seam, as {@link resolveEngineRelease} takes it. */
  fetch?: EngineFetch;
  /** Clock seam (epoch ms). */
  now?: number;
  /** Override {@link UPDATE_CHECK_TIMEOUT_MS} — tests only. */
  timeoutMs?: number;
}

/**
 * The newest published engine for `platform` (with its `v`), or `undefined`
 * when opted out or it cannot be known. Answered from `latest.json` when that
 * is under an hour old; otherwise asked once, bounded overall, and cached. A
 * failed ask falls back to the stale cached answer and is recorded, so the next
 * {@link UPDATE_CHECK_FAILURE_BACKOFF_MS} answer from the cache without asking.
 * Never throws.
 */
export async function latestKnownVersion(opts: LatestKnownVersionOptions): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  if (optedOut(env)) return undefined;
  const now = opts.now ?? Date.now();
  let cached: string | undefined;
  try {
    const entry = readLatest(env).platforms?.[opts.platform];
    cached = entry?.version;
    if (entry?.checkedAt !== undefined && now - entry.checkedAt < UPDATE_CHECK_TTL_MS) return cached;
    if (entry?.failedAt !== undefined && now - entry.failedAt < UPDATE_CHECK_FAILURE_BACKOFF_MS) return cached;

    const { version } = await withDeadline(opts.fetch, opts.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS, (fetch) =>
      resolveEngineRelease({ platform: opts.platform, env, fetch }),
    );
    // A success replaces the entry outright, dropping any failedAt.
    writePlatform(env, opts.platform, () => ({ version, checkedAt: now }));
    return version;
  } catch {
    // Keep the last good answer; only note when this attempt failed.
    writePlatform(env, opts.platform, (prev) => ({ ...prev, failedAt: now }));
    return cached;
  }
}

/**
 * Replace one platform's entry, re-reading first so a decline (or another
 * platform's entry) recorded meanwhile is not overwritten. Best-effort.
 */
function writePlatform(
  env: NodeJS.ProcessEnv,
  platform: EnginePlatform,
  next: (prev: PlatformEntry | undefined) => PlatformEntry,
): void {
  try {
    const file = readLatest(env);
    writeLatest(env, { ...file, platforms: { ...file.platforms, [platform]: next(file.platforms?.[platform]) } });
  } catch {
    /* an unwritable cache only means asking again next deploy */
  }
}

/**
 * Remember that the developer declined `version` for the project at
 * `projectDir`. Later deploys notice it without prompting; a newer release
 * prompts again. Best-effort: a cache that cannot be written is not an error.
 */
export function recordDeclined(projectDir: string, version: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const file = readLatest(env);
    writeLatest(env, { ...file, declined: { ...file.declined, [resolve(projectDir)]: normalizeEngineVersion(version) } });
  } catch {
    /* forgetting a decline only means being asked again */
  }
}

/** The version last declined for the project at `projectDir`, if any. */
export function declinedVersion(projectDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readLatest(env).declined?.[resolve(projectDir)];
}

/** What a deploy does about a newer engine: nothing, ask, or print the one-line notice. */
export type UpdateDecision = "keep" | "offer" | "notify";

/**
 * Pure. `keep` unless `latest` is strictly newer than `pin`; then `offer`
 * (prompt) when interactive and `latest` is not the version already declined,
 * else `notify`. A leading `v` is optional on every argument; an unparseable
 * version keeps the pin.
 */
export function decideUpdate(input: {
  pin: string;
  latest: string | undefined;
  interactive: boolean;
  declined?: string | undefined;
}): UpdateDecision {
  if (input.latest === undefined) return "keep";
  const pin = parseSemver(input.pin);
  const latest = parseSemver(input.latest);
  if (!pin || !latest || compareSemver(latest, pin) <= 0) return "keep";
  const declined = input.declined === undefined ? null : parseSemver(input.declined);
  const alreadyDeclined = declined !== null && compareSemver(declined, latest) === 0;
  return input.interactive && !alreadyDeclined ? "offer" : "notify";
}

/**
 * Whether this run may prompt: stdin and stderr are both terminals, `CI` is
 * unset or empty, and output is not for a machine (`--json`). Decided before
 * prompting, because `confirm` throws on a non-terminal stdin.
 */
export function isInteractive(opts: {
  machineOutput: boolean;
  env?: NodeJS.ProcessEnv;
  stdin?: { isTTY?: boolean };
  stderr?: { isTTY?: boolean };
}): boolean {
  const env = opts.env ?? process.env;
  const stdin = opts.stdin ?? process.stdin;
  const stderr = opts.stderr ?? process.stderr;
  return !opts.machineOutput && !env.CI && stdin.isTTY === true && stderr.isTTY === true;
}

const withV = (v: string) => (v.trim().startsWith("v") ? v.trim() : `v${v.trim()}`);

/** The update question. The prompt helper appends `(y/N)`; the default is no. */
export function updatePromptText(pin: string, latest: string): string {
  return (
    `Engine ${withV(latest)} is available (this project is pinned to ${withV(pin)}). Update now? ` +
    `The engine restarts empty, so local rows are dropped and re-seeded, even with --keep-data.`
  );
}

/** The one-line notice for a run that does not prompt. */
export function updateNoticeText(pin: string, latest: string): string {
  return `Engine ${withV(latest)} is available (pinned: ${withV(pin)}). Run \`xanosdk local-engine update\` to move to it.`;
}
