/**
 * Turning "a version (or `latest`) and a platform" into "the one archive to
 * download, and the digest it must hash to" — by asking the release manager.
 *
 * The release manager is a public index: every published engine release, each
 * with one archive per platform it was built for and that archive's sha256.
 * Asking it is what lets a bare `--local` work with nothing configured,
 * and what lets a project pin a version everyone on it resolves the same way.
 *
 * **Unauthenticated, always.** The index is public, so no request here carries
 * a credential — not even when `XANOSDK_ENGINE_TOKEN` is set, which
 * belongs to an operator-named download URL and to nothing else.
 *
 * Responses are projected field by field rather than cast, in the style of
 * `marketplace-catalogue.ts`: an asset whose digest is not 64 lowercase hex, or
 * whose download is not `https`, is treated as ABSENT rather than trusted. The
 * digest returned here is the one the downloaded bytes are held to, so a
 * malformed one is not a warning — it is no asset.
 *
 * Node-only, reached by a lazy import from the command layer.
 */
import { readEnvVar } from "../util/env.js";
import { describeTransportFailure, fetchOrExplain, TransportError } from "../util/http.js";
import type { EnginePlatform } from "./local-engine-config.js";
import type { EngineFetch } from "./local-engine-release.js";
import { LOOPBACK_HOSTS } from "./local-engine-handshake.js";

/**
 * Where the release manager's public API lives.
 *
 * One hardcoded host in a published package, like the marketplace catalogue's:
 * if it ever moves, every installed copy loses version resolution at once and
 * only a release fixes it. {@link ENGINE_RELEASES_URL_ENV} is the reason that is
 * survivable — it repoints resolution without an upgrade.
 */
export const DEFAULT_ENGINE_RELEASES_URL = "https://xo2z-4vn5-mdxv.dev.xano.io/api:engine-mirror";

/**
 * The override for {@link DEFAULT_ENGINE_RELEASES_URL}. Presence with a value is
 * the signal; an empty string counts as unset, so `XANOSDK_ENGINE_RELEASES_URL=`
 * in a shared `.env` cannot point resolution at nothing.
 */
export const ENGINE_RELEASES_URL_ENV = "XANOSDK_ENGINE_RELEASES_URL";

/**
 * Whether {@link ENGINE_RELEASES_URL_ENV} names a release manager other than
 * the default one.
 *
 * Another manager can publish different bytes under a version the default one
 * also has, and the engine cache and the update check are keyed by version. So
 * an engine from a custom manager is downloaded fresh on every run and staged
 * apart from `bin/<version>/`, and the deploy neither pins it nor offers
 * updates. The default address spelled out (with or without a trailing slash)
 * is still the default.
 */
export function usesCustomReleaseManager(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = readEnvVar(ENGINE_RELEASES_URL_ENV, env);
  if (raw === undefined) return false;
  return raw.replace(/\/+$/, "") !== DEFAULT_ENGINE_RELEASES_URL;
}

/** Bound every lookup so a stalled index cannot hang a deploy. Same budget as the catalogue. */
const RELEASES_TIMEOUT_MS = 30_000;

/**
 * How many pages of `GET releases` `latest` reads before giving up.
 *
 * The list is newest first, so a platform missing from the newest few releases
 * is found within a page or two. The bound exists so a server that always
 * answers with a `nextPage` cannot turn one deploy into an unbounded crawl.
 */
const MAX_LATEST_PAGES = 4;

/** The only version shape the release manager matches — exactly, with the leading `v`. */
const VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** One release's archive for one platform — everything acquisition needs to fetch and verify it. */
export interface EngineReleaseAsset {
  /** Always with its leading `v` (`v0.1.4`), the spelling the release manager matches. */
  version: string;
  /** The archive's own file name — the last segment of {@link downloadUrl}. */
  filename: string;
  /** Lowercase hex SHA-256 of the archive, as the release recorded it. */
  sha256: string;
  /** Absolute `https` URL (loopback `http` only, for a local test server). Redirects to storage. */
  downloadUrl: string;
}

export interface ResolveEngineReleaseOptions {
  /** A `vMAJOR.MINOR.PATCH` version (the `v` is optional), or `latest`. Absent means `latest`. */
  version?: string | undefined;
  platform: EnginePlatform;
  env?: NodeJS.ProcessEnv;
  /** The network seam — defaulted to the shared HTTP helper. */
  fetch?: EngineFetch;
}

/**
 * `version` in the one spelling the release manager matches, or a refusal.
 *
 * The missing `v` is added here, once, so every version this SDK stores or
 * prints carries it and `0.1.4` and `v0.1.4` can never be two cache entries or
 * two pins. The pattern is checked before anything is built from the value,
 * which is also what keeps a version out of the URL path as anything but a
 * single segment.
 */
export function normalizeEngineVersion(version: string): string {
  const trimmed = version.trim();
  if (!VERSION_PATTERN.test(trimmed)) {
    throw new Error(
      `"${version}" is not an engine version — they are written vMAJOR.MINOR.PATCH, like v0.1.5.\n` +
        `Pass a version in that form, or \`latest\`.`,
    );
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function isLoopback(url: URL): boolean {
  // `URL` keeps the brackets on an IPv6 host; the shared list spells it bare.
  return LOOPBACK_HOSTS.includes(url.hostname.replace(/^\[|\]$/g, ""));
}

/** `https`, or `http` to this machine only. Anything else is not a place to fetch an engine from. */
function isTrustedUrl(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url));
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * The releases base, and how to name it in output.
 *
 * Refused unless it is `https` (or loopback `http`): the digest this module
 * returns is what the downloaded engine is verified against, so an index read
 * over plain HTTP would let anyone on the path choose both the bytes and the
 * digest that approves them.
 */
function releasesBase(env: NodeJS.ProcessEnv): ReleasesBase {
  const set = readEnvVar(ENGINE_RELEASES_URL_ENV, env);
  const raw = set ?? DEFAULT_ENGINE_RELEASES_URL;
  const url = parseUrl(raw);
  if (url === undefined || !isTrustedUrl(url)) {
    throw new Error(
      `${ENGINE_RELEASES_URL_ENV} must be an https URL, and is not — so no engine release was looked up.\n` +
        `Set it to the release manager's https address, or unset it to use the default.`,
    );
  }
  const base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  // The base is public and may be named, but never with userinfo or a query.
  return { base, display: base, fromEnv: set !== undefined };
}

/**
 * Where the release manager's address came from, so a remedy names the one in
 * use — "(or XANOSDK_ENGINE_RELEASES_URL, if set)" left the reader to find out
 * whether it was (E2E pass 28).
 */
interface ReleasesBase {
  base: string;
  display: string;
  /** Whether {@link ENGINE_RELEASES_URL_ENV} set the address, rather than the default. */
  fromEnv: boolean;
}

/** The re-run line for a release manager that could not be reached. */
function unreachableRemedy(where: ReleasesBase): string {
  return where.fromEnv
    ? `Check the network, and ${ENGINE_RELEASES_URL_ENV} (set to ${where.display}), then re-run.`
    : "Check the network and re-run.";
}

/** The re-run line for an answer that is not a release listing. */
function notListingRemedy(where: ReleasesBase): string {
  return where.fromEnv
    ? `${ENGINE_RELEASES_URL_ENV} is set to ${where.display} — check it addresses the release manager's API, or unset it for the default, then re-run.`
    : "Re-run in a moment; if it keeps failing, the release index is down.";
}

/** The asset for `platform` in a release body, or `undefined` when it has none worth trusting. */
function pickAsset(body: unknown, platform: EnginePlatform): EngineReleaseAsset | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const { version, assets } = body as { version?: unknown; assets?: unknown };
  if (typeof version !== "string" || !VERSION_PATTERN.test(version) || !Array.isArray(assets)) return undefined;
  for (const a of assets as unknown[]) {
    if (a === null || typeof a !== "object") continue;
    const { platform: p, filename, sha256, download_url } = a as Record<string, unknown>;
    if (p !== platform) continue;
    if (typeof filename !== "string" || filename === "") continue;
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) continue;
    if (typeof download_url !== "string") continue;
    const dl = parseUrl(download_url);
    if (dl === undefined || !isTrustedUrl(dl)) continue;
    return { version: normalizeEngineVersion(version), filename, sha256, downloadUrl: download_url };
  }
  return undefined;
}

async function getJson(
  url: string,
  where: ReleasesBase,
  fetch: EngineFetch,
): Promise<{ status: number; body: unknown }> {
  const { display } = where;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      // No Authorization, deliberately: the index is public.
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(RELEASES_TIMEOUT_MS),
    });
  } catch (err) {
    // One sentence, one remedy: the transport's own message is a sentence with
    // its own "Nothing was changed — retry." line, and nested under this one it
    // read "could not be reached: resolve the engine release could not reach
    // …", then retry twice (E2E pass 27). Only its reason is kept.
    const reason =
      err instanceof TransportError && err.timeout
        ? `it did not answer within ${Math.round(RELEASES_TIMEOUT_MS / 1000)}s`
        : describeTransportFailure(err instanceof TransportError && err.cause !== undefined ? err.cause : err);
    throw new Error(
      `The engine release manager at ${display} could not be reached: ${reason.replace(/\.$/, "")}. Nothing was changed.\n` +
        unreachableRemedy(where),
      { cause: err },
    );
  }
  if (!res.ok) return { status: res.status, body: undefined };
  try {
    return { status: res.status, body: await res.json() };
  } catch {
    throw new Error(
      `The engine release manager at ${display} answered with something that is not a release listing.\n` +
        notListingRemedy(where),
    );
  }
}

/**
 * A version the release manager does not publish. Exits 8, the CLI's
 * not-found code (a named thing that is not there), rather than the generic 1.
 * The literal, not the constant: this layer does not import the CLI's modules.
 */
export class EngineReleaseNotFoundError extends Error {
  override readonly name = "EngineReleaseNotFoundError";
  readonly exitCode = 8;
}

function failed(status: number, display: string): Error {
  const err = new Error(
    `The engine release manager at ${display} failed (HTTP ${status}).\n` +
      `Re-run in a moment; if it keeps failing, the release index is down.`,
  );
  // A server error is an unanswered release lookup: exit 8, as a connection
  // that never opened is. The literal, not the constant: see above.
  if (status >= 500) Object.defineProperty(err, "exitCode", { value: 8, enumerable: true });
  return err;
}

/**
 * The release to run on `platform` — an explicit version, or the newest
 * published release that has an archive for it — or a refusal naming why not.
 *
 * `latest` walks the release LIST rather than asking for `releases/latest`: a
 * release is published once the archives it has are stored, so the newest one
 * can lack a platform, and a first deploy on that platform should get the
 * newest release that serves it rather than a refusal.
 *
 * Every refusal happens before anything downloads.
 */
export async function resolveEngineRelease(opts: ResolveEngineReleaseOptions): Promise<EngineReleaseAsset> {
  const env = opts.env ?? process.env;
  const { platform } = opts;
  const wanted =
    opts.version === undefined || opts.version === "latest" ? undefined : normalizeEngineVersion(opts.version);
  const where = releasesBase(env);
  const { base, display } = where;
  const fetch: EngineFetch =
    opts.fetch ??
    ((url, init) => fetchOrExplain(url, init, "resolve the engine release", RELEASES_TIMEOUT_MS, display));

  if (wanted !== undefined) {
    const { status, body } = await getJson(
      `${base}/releases/${encodeURIComponent(wanted)}?product=engine`,
      where,
      fetch,
    );
    if (status === 404) {
      throw new EngineReleaseNotFoundError(
        `There is no published engine release ${wanted}.\n` +
          `Check the version, or run \`xanosdk local update\` to move to the latest one.`,
      );
    }
    if (body === undefined) throw failed(status, display);
    const asset = pickAsset(body, platform);
    if (asset === undefined) {
      throw new Error(
        `Engine release ${wanted} has no archive for ${platform}, so nothing was downloaded.\n` +
          `Run \`xanosdk local update\` to move to a release built for ${platform}.`,
      );
    }
    return asset;
  }

  for (let pageNo = 1; pageNo <= MAX_LATEST_PAGES; pageNo++) {
    const { status, body } = await getJson(`${base}/releases?product=engine&page=${pageNo}`, where, fetch);
    if (body === undefined) throw failed(status, display);
    const { items, nextPage } = (body ?? {}) as { items?: unknown; nextPage?: unknown };
    if (!Array.isArray(items)) {
      throw new Error(
        `The engine release manager at ${display} answered with something that is not a release listing.\n` +
          notListingRemedy(where),
      );
    }
    // Newest first, so the first release carrying this platform is the newest that does.
    for (const item of items as unknown[]) {
      const asset = pickAsset(item, platform);
      if (asset !== undefined) return asset;
    }
    if (typeof nextPage !== "number") break;
  }
  throw new Error(
    `No published engine release has an archive for ${platform}, so nothing was downloaded.\n` +
      `Deploy from a machine the engine is published for, or wait for a release built for ${platform}.`,
  );
}
