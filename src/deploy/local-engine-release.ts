/**
 * Turning "an engine source and a supported machine" into "an executable whose
 * bytes match the digest recorded when they were fetched".
 *
 * Two sources, two trust stories:
 *
 * - **A published release.** The release manager names the archive and the
 *   sha256 it must hash to ({@link resolveEngineRelease}), and that recorded
 *   digest is the AUTHORITY: the downloaded bytes are held to it before a byte
 *   reaches the cache. No credential is sent — the release is public.
 * - **An override** the operator named on the flag: a URL or an archive path.
 *   Nothing in the package vouches for it, so this verifies something narrower
 *   — that what runs today is byte-identical to what was fetched — and treats a
 *   checksum published beside the artifact as a cross-check, never the
 *   authority.
 *
 * Node-only, reached by a lazy import from the command layer.
 */
import { readEnvVar } from "../util/env.js";
import { registerSecret, tokenTextProblem } from "../util/secrets.js";
import { UsageError } from "../emit/errors.js";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { sha256Hex } from "../util/sha256.js";
import { fetchOrExplain, TransportError } from "../util/http.js";
import {
  type EngineSourceSpec,
  SUPPORTED_PLATFORMS,
  isTrustedEngineUrl,
  expandArchivePath,
  resolveEnginePlatform,
} from "./local-engine-config.js";
import {
  type EngineCacheEntry,
  readEngineEntry,
  stageEngine,
  verifiedEngineExecutable,
} from "./local-engine-cache.js";
import {
  type EngineReleaseAsset,
  normalizeEngineVersion,
  resolveEngineRelease,
  usesCustomReleaseManager,
} from "./local-engine-releases.js";

/**
 * The environment variable that supplies a credential for the download, when
 * one is needed.
 *
 * The ENVIRONMENT supplies it, never the package and never a discovery step:
 * the credential belongs to whoever has access to the engine's release, and the
 * SDK has no business knowing what that is. It is attached to the host of the
 * URL the operator passed and to nothing else — see {@link fetchFollowingRedirects}.
 */
export const LOCAL_ENGINE_TOKEN_ENV = "XANOSDK_ENGINE_TOKEN";

/**
 * The most the archive is allowed to decompress to.
 *
 * A bound rather than a size: the measured executable is around 63MB, and this
 * is generous enough that a bigger engine is not an outage while a gzip bomb
 * still cannot ask this process for unbounded memory.
 */
export const MAX_ENGINE_BYTES = 256 * 1024 * 1024;

/** Bound the download so a stalled or endless response cannot hang a deploy. */
const DOWNLOAD_TIMEOUT_MS = 600_000;

/** How many redirects are followed before the chain is called a loop. */
const MAX_REDIRECTS = 5;

/**
 * How a download URL is named in human output: its origin and path, never its
 * query string, fragment or userinfo — a pre-signed storage link carries its
 * credential in the query, and one must not reach a log, a CI transcript or a
 * support paste. The URL is named at all because "could not reach the engine
 * download URL" leaves the operator guessing which one.
 */
export function displayDownloadUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search !== "" ? "?…" : ""}`;
  } catch {
    return "the engine download URL";
  }
}

/**
 * The seam every request goes through, so the tests drive acquisition with no
 * network at all.
 *
 * It is a parameter rather than a module-level mock because the assertion that
 * matters on most of these paths is that it was NOT called — an unsupported
 * machine, a cache hit — and a call count is the only form of that assertion
 * that cannot be explained away by the real implementation.
 */
export type EngineFetch = (url: string, init: RequestInit) => Promise<Response>;

const defaultFetch: EngineFetch = (url, init) =>
  fetchOrExplain(url, init, "The Xano Engine download", DOWNLOAD_TIMEOUT_MS, displayDownloadUrl(url));

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Fetch `url`, following redirects by hand so the credential stops at the host
 * it belongs to.
 *
 * A release download normally redirects to signed storage, and the signature in
 * that link IS the authorization — handing it a bearer as well would both be
 * redundant and give a storage host a credential it never needed. `fetch`'s own
 * redirect following replays headers across the hop, so the hops are walked
 * here instead.
 */
async function fetchFollowingRedirects(
  url: string,
  opts: { token: string | undefined; fetch: EngineFetch; release?: string },
): Promise<Response> {
  const origin = safeOrigin(url);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { accept: "application/octet-stream" };
    // Host-scoped, and compared on the ORIGIN rather than the hostname: a
    // redirect that downgrades the scheme is a different destination.
    if (opts.token !== undefined && safeOrigin(current) === origin) {
      headers.Authorization = `Bearer ${opts.token}`;
    }
    const res = await opts.fetch(current, {
      method: "GET",
      headers,
      // Manual, or `fetch` would follow the hop with the header still attached.
      redirect: "manual",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!isRedirect(res.status)) return res;
    const location = res.headers.get("location");
    if (location === null || location === "") return res;
    current = new URL(location, current).href;
  }
  // A release download names no URL the operator typed, so the remedy for it is
  // moving to another release, not checking a flag they never passed.
  throw new Error(
    `The engine download redirected more than ${MAX_REDIRECTS} times, so it was abandoned.\n` +
      (opts.release === undefined
        ? `Check the URL passed to \`--local\` addresses the artifact itself.`
        : `Re-run in a moment; if it keeps failing, engine ${opts.release}'s archive is ` +
          `unavailable — \`xanosdk local update\` moves to another release.`),
  );
}

/** An origin, or the raw string when the URL will not parse (it is about to fail anyway). */
function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * The refusal for a release download the server would not serve.
 *
 * Names the version and never the override credential: a release is public,
 * so a refused download is the release's download being unavailable — telling
 * the operator to set a token would send them after a cause that is not there.
 */
function releaseDownloadRefusal(status: number, version: string): Error {
  return unresolvedOn5xx(
    status,
    new Error(
      `The download of engine ${version} failed (HTTP ${status}), so nothing was written.\n` +
        `Re-run in a moment; if it keeps failing, that release's archive is unavailable — ` +
        `\`xanosdk local update\` moves to another release.`,
    ),
  );
}

/**
 * A server error (5xx) getting the engine is a failure to RESOLVE it, as a
 * connection that never opened is: exit 8 with the rerun, not 1 (E2E pass 27:
 * a 502 exited 1 while ECONNRESET exited 8). A 4xx is the server's answer about
 * the artifact and keeps the generic code.
 */
export function unresolvedOn5xx(status: number, err: Error): Error {
  if (status >= 500) Object.defineProperty(err, "exitCode", { value: EXIT_ENGINE_UNREACHABLE, enumerable: true });
  return err;
}

/**
 * The refusal for an override download the server would not serve.
 *
 * 401 and 403 are a credential problem and say so. A 404 is reported as what it
 * is — nothing at that URL — with the credential named second, because a
 * private release ALSO answers an unauthenticated request with 404.
 */
function downloadRefusal(status: number, hasToken: boolean): Error {
  if (status === 404) {
    return new Error(
      `The engine download found nothing at that URL (HTTP 404 Not Found).\n` +
        `Check the URL passed to \`--local\` addresses the artifact` +
        (hasToken
          ? ` and that ${LOCAL_ENGINE_TOKEN_ENV} can read it`
          : `; if it is a private release, which also answers 404 without a credential, set ` +
            `${LOCAL_ENGINE_TOKEN_ENV} to one that can read it`) +
        `, then re-run.`,
    );
  }
  if (status === 401 || status === 403) {
    return new Error(
      `The engine download was refused (HTTP ${status}), which is what an engine release ` +
        `answers when the credential is missing or no longer authorized — not that the ` +
        `artifact is absent.\n` +
        `Set ${LOCAL_ENGINE_TOKEN_ENV} to a credential that can read the release and re-run.`,
    );
  }
  if (status >= 500) {
    return unresolvedOn5xx(
      status,
      new Error(
        `The engine download failed (HTTP ${status}) — the server hosting it erred, so nothing was written.\n` +
          `Re-run in a moment; if it keeps failing, check the URL passed to \`--local\` is still served.`,
      ),
    );
  }
  return new Error(
    `The engine download failed (HTTP ${status}).\n` +
      `Check the URL passed to \`--local\` still addresses the artifact` +
      (hasToken ? ` and that ${LOCAL_ENGINE_TOKEN_ENV} can read it` : ``) +
      `, then re-run.`,
  );
}

/**
 * The artifact's own file name — the last path segment of the URL.
 *
 * It is what a multi-artifact checksums file keys its rows on, so it is the
 * only way to take the right row out of one.
 */
function artifactName(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split("/").pop();
    return last === undefined || last === "" ? undefined : decodeURIComponent(last);
  } catch {
    return undefined;
  }
}

/**
 * Where a checksum published beside the artifact might be.
 *
 * Two conventions, because releases use both: a per-artifact sidecar, and one
 * checksums file covering every artifact of a release. Neither name says
 * anything about where the engine is published — they are the two spellings
 * this convention has anywhere it is used.
 */
function checksumCandidates(url: string): string[] {
  try {
    const sidecar = new URL(url);
    sidecar.pathname = `${sidecar.pathname}.sha256`;
    const siblings = new URL(url);
    const parts = siblings.pathname.split("/");
    parts[parts.length - 1] = "SHA256SUMS";
    siblings.pathname = parts.join("/");
    return [sidecar.href, siblings.href];
  } catch {
    return [];
  }
}

/**
 * The digest for `name` in a published checksums document.
 *
 * A checksums file covering a whole release holds one `<digest>  <file>` row
 * per artifact, and taking the FIRST digest out of it is a real bug rather than
 * a loose end: on any machine whose artifact is not the first row, the
 * cross-check would compare good bytes against another platform's digest and
 * refuse them. So a document with rows is matched BY NAME, and one that names
 * nothing is read as a bare digest for the artifact that was asked for.
 *
 * Anything else — rows that name other artifacts only, several rows for this
 * one — is `undefined`. An ambiguous second source is not a second source.
 */
export function parsePublishedChecksum(text: string, name: string | undefined): string | undefined {
  // `*name` is the binary-mode marker `sha256sum` writes; `./name` is ordinary.
  const rows = [...text.matchAll(/^([0-9a-f]{64})[ \t]+[*]?(\S+)[ \t]*$/gm)].map((m) => ({
    digest: m[1]!,
    file: m[2]!.replace(/^\.\//, "").split("/").pop()!,
  }));
  if (rows.length === 0) {
    const bare = /^[ \t]*([0-9a-f]{64})[ \t]*$/m.exec(text);
    return bare?.[1];
  }
  if (name === undefined) return undefined;
  const matched = rows.filter((r) => r.file === name);
  return matched.length === 1 ? matched[0]!.digest : undefined;
}

/**
 * The checksum a release publishes beside the artifact, when it publishes one.
 *
 * `undefined` for every failure — absent, unreadable, unparseable, or naming
 * artifacts but not this one. This is a CROSS-CHECK: a second source agreeing
 * with the bytes is worth having, and a second source that is not there is not
 * a reason to refuse an artifact the operator named themselves.
 */
async function publishedChecksum(
  url: string,
  opts: { token: string | undefined; fetch: EngineFetch },
): Promise<string | undefined> {
  const name = artifactName(url);
  for (const candidate of checksumCandidates(url)) {
    try {
      const res = await fetchFollowingRedirects(candidate, opts);
      if (!res.ok) continue;
      const digest = parsePublishedChecksum(await res.text(), name);
      if (digest !== undefined) return digest;
    } catch {
      // An unreachable cross-check is not a reason to refuse; try the next.
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

function octal(buf: Uint8Array): number {
  const text = new TextDecoder().decode(buf).replace(/\0.*$/s, "").trim();
  const n = Number.parseInt(text, 8);
  return Number.isFinite(n) ? n : 0;
}

function headerName(block: Uint8Array): string {
  return new TextDecoder().decode(block.subarray(0, 100)).replace(/\0.*$/s, "");
}

function headerChecksumOk(block: Uint8Array): boolean {
  const stored = octal(block.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return sum === stored;
}

/**
 * The refusal for an archive of the wrong shape. `release` names the published
 * version it came from: that archive already matched its release's sha256, so
 * the release itself is unusable and the remedy is another one — not checking a
 * flag the operator never passed.
 */
const badArchive = (why: string, release: string | undefined): Error =>
  new Error(
    `The engine archive ${why}.\n` +
      `It is not the artifact this expects, so nothing was written. ` +
      (release === undefined
        ? `Check the URL or path passed to \`--local\` addresses the engine archive ` +
          `itself — a partial download, a login page and a release listing all save as ` +
          `ordinary files.`
        : `Engine ${release}'s published archive is unusable; \`xanosdk local update\` ` +
          `moves to another release.`),
  );

/**
 * The one executable inside the archive.
 *
 * The archive holds EXACTLY ONE member — a regular file with a plain name and
 * no directory prefix — so every other shape is genuinely unexpected and is
 * rejected rather than accommodated: a second member, a symlink or directory
 * entry, an absolute or traversing name, a stored setuid bit, and a decompressed
 * size past {@link MAX_ENGINE_BYTES}.
 *
 * A symlink member is the one worth naming. It is the traversal that contains
 * no `..` at all, so a writer that checks names and ignores the type flag walks
 * straight out of the target directory — which is why the type is checked
 * first, and why this returns BYTES rather than writing anything itself.
 *
 * The stored mode is read only to refuse it. The cache sets its own mode on
 * what it stages; nothing an archive says about permissions is honored.
 */
export function extractEngineExecutable(
  archive: Uint8Array,
  opts: { maxBytes?: number; release?: string } = {},
): Uint8Array {
  const maxBytes = opts.maxBytes ?? MAX_ENGINE_BYTES;
  const refuse = (why: string): Error => badArchive(why, opts.release);
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: maxBytes });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw refuse(`decompresses to more than the ${maxBytes}-byte bound and is too large`);
    }
    throw refuse("is not a gzip archive");
  }

  const found: Uint8Array[] = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break; // the terminating zero blocks
    if (!headerChecksumOk(block)) throw refuse("is not a tar archive");

    const type = String.fromCharCode(block[156]!);
    if (type !== "0" && type !== "\0") {
      throw refuse(`holds a ${type === "5" ? "directory" : "link"} where a regular file belongs`);
    }
    const mode = octal(block.subarray(100, 108));
    if ((mode & 0o7000) !== 0) {
      throw refuse("stores a setuid, setgid or sticky mode bit on its contents");
    }
    const name = headerName(block);
    const prefix = new TextDecoder().decode(block.subarray(345, 500)).replace(/\0.*$/s, "");
    if (name === "" || name.startsWith("/") || name.includes("/") || name.includes("\\") || prefix !== "") {
      throw refuse(`holds a member whose name addresses a location ("${prefix}${name}")`);
    }
    const size = octal(block.subarray(124, 136));
    const start = offset + 512;
    if (start + size > tar.length) throw refuse("is truncated");
    found.push(new Uint8Array(tar.subarray(start, start + size)));
    if (found.length > 1) throw refuse("holds more than the one file it should");
    offset = start + Math.ceil(size / 512) * 512;
  }

  const only = found[0];
  if (only === undefined) throw refuse("holds no files, where it should hold one file");
  return only;
}

/* ------------------------------------------------------------------ *
 * Where the bytes come from
 * ------------------------------------------------------------------ */

/**
 * Is this source something to FETCH, or something to READ off the disk?
 *
 * `http(s)://` and nothing else is a URL. Everything else is a path, rather
 * than the other way around, because a path is what the operator can mistype:
 * a value that fails this test and is treated as a file gives a refusal naming
 * the path it tried, while one treated as a URL would fail somewhere inside the
 * fetch with a cause the operator never wrote down.
 */
function isDownloadUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/**
 * A source that is a path, as an absolute path.
 *
 * `~` is expanded here rather than left to the shell: the glued form
 * (`--local=~/Downloads/engine.tar.gz`) is the one being recommended to
 * testers, and no shell expands a tilde in the middle of a word. HOME is read
 * off the SAME env the rest of this module takes, so a test can name a home
 * directory the way it names the cache root.
 *
 * The result is what identifies the cache entry, so two spellings of one file —
 * `./engine.tgz` and the absolute path — share an engine rather than staging it
 * twice.
 */
function resolveArchivePath(source: string, env: NodeJS.ProcessEnv): string {
  return expandArchivePath(source, env);
}

/**
 * The archive at `path`, or a refusal naming the path it looked at.
 *
 * Three beats, because this is the failure a tester who was handed a file hits
 * first: what happened, what fixes it, what still works meanwhile.
 */
function readArchiveFile(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    throw new Error(
      `There is no engine archive to read at ${path}.\n` +
        `Check the path — it is read exactly as passed to \`--local\`, with \`~\` and ` +
        `relative paths resolved from where the command ran.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Acquisition
 * ------------------------------------------------------------------ */

/** What {@link acquireEngine} needs: a machine, a resolved source, and a way out to the network. */
export interface AcquireEngineOptions {
  /**
   * Where the engine comes from, as {@link resolveEngineSource} decided it: a
   * release (a version, or latest) or an override the flag named.
   */
  spec: EngineSourceSpec;
  env?: NodeJS.ProcessEnv;
  /**
   * The command to run again, as typed, for a failure whose remedy is a rerun:
   * "Re-run in a moment" then names it (E2E pass 29 — a remedy is printed so
   * that it runs as printed). Absent, the generic line stays.
   */
  rerun?: string;
  /**
   * What that rerun leaves out — the withheld `--env-var` values it names —
   * appended to the failure, as every other printed rerun carries it.
   */
  rerunNote?: string;
  /** Defaulted to the running process; taken as arguments so a test can ask about another machine. */
  platform?: string;
  arch?: string;
  /**
   * The network seam — defaulted to the shared HTTP helper. One seam for both
   * the release lookup and the download, so a cache hit's "zero calls" covers
   * both.
   */
  fetch?: EngineFetch;
}

/** The engine {@link acquireEngine} settled on. */
export interface AcquiredEngine {
  entry: EngineCacheEntry;
  /** The release version it resolved to (`v0.1.5`); absent for an override. */
  version: string | undefined;
}

/**
 * The engine to run, cached and verified, or a refusal naming why there is none.
 *
 * An unsupported machine refuses before any network call at all. Then the
 * source decides: a release is looked up by version in the cache and only
 * resolved and downloaded on a miss; an override takes the operator-named
 * pipeline. The order that picked the source lives in
 * {@link resolveEngineSource}, not here.
 *
 * Every path that RETURNS goes through the digest re-check, so a caller holding
 * the result holds an executable whose bytes are the ones that were fetched.
 * A cached entry that no longer matches is a REFUSAL, not a cache miss — it is
 * re-fetched only when the operator deletes it, because silently replacing it
 * would erase the one signal that something rewrote an executable this SDK
 * spawns.
 */
export async function acquireEngine(opts: AcquireEngineOptions): Promise<AcquiredEngine> {
  try {
    return await acquireEngineUnclassified(opts);
  } catch (err) {
    // A network failure while getting the engine — its release lookup or its
    // download — is a failure to RESOLVE the engine a deploy named: nothing was
    // started or written yet. So it exits 8 with the rerun, as a backend's
    // lookup that got no answer does, rather than 1 (E2E pass 26: a download
    // that could not connect exited 1 while every lookup exited 8).
    let transport = false;
    for (let e: unknown = err; e instanceof Error && !transport; e = e.cause) transport = e instanceof TransportError;
    if (transport) Object.defineProperty(err, "exitCode", { value: EXIT_ENGINE_UNREACHABLE, enumerable: true });
    if (opts.rerun !== undefined && err instanceof Error) {
      const named = namingRerun(err.message, opts.rerun);
      err.message = named !== err.message && opts.rerunNote !== undefined ? `${named}${opts.rerunNote}` : named;
    }
    throw err;
  }
}

/** `message` with its generic rerun lines naming `command` — the class, and so the exit code, kept by the caller. */
export function namingRerun(message: string, command: string): string {
  return message
    .replace(/\bRe-run in a moment/g, `Run \`${command}\` again in a moment`)
    .replace(/(,? then| and) re-run\./g, `$1 run \`${command}\` again.`);
}

/** The CLI's "a named thing could not be addressed" exit, for an engine that could not be fetched. */
const EXIT_ENGINE_UNREACHABLE = 8;

async function acquireEngineUnclassified(opts: AcquireEngineOptions): Promise<AcquiredEngine> {
  const env = opts.env ?? process.env;
  const platform = resolveEnginePlatform(opts.platform ?? process.platform, opts.arch ?? process.arch);

  if (platform === undefined) {
    throw new Error(
      `There is no Xano Engine build for ${opts.platform ?? process.platform} ` +
        `${opts.arch ?? process.arch} — it runs on ${SUPPORTED_PLATFORMS.join(", ")} and nothing ` +
        `else.\nDeploy from one of those machines, or drop \`--local\`: \`xanosdk deploy\` ` +
        `reaches an ephemeral from anywhere.`,
    );
  }

  if (opts.spec.kind === "release") {
    return acquireRelease(opts.spec.version, platform, env, opts.fetch);
  }
  const entry = await acquireOverride(opts.spec.source, env, opts.fetch ?? defaultFetch);
  return { entry, version: undefined };
}

/**
 * A published release: the cache by version, else one download held to the
 * release's recorded sha256.
 *
 * A PINNED version already cached is answered from disk alone — no lookup, no
 * request — which is what lets a pinned project deploy offline. Latest has to
 * ask which version is newest, but a version it names that is already cached
 * is not downloaded again.
 *
 * A custom release manager skips the version cache in both directions: it is
 * never read (the cached `v0.1.5` may be another manager's bytes) and the
 * download is staged keyed by its URL, never under `bin/<version>/`. Every run
 * downloads; the release's sha256 still holds the bytes.
 */
async function acquireRelease(
  requested: string | undefined,
  platform: NonNullable<ReturnType<typeof resolveEnginePlatform>>,
  env: NodeJS.ProcessEnv,
  fetch: EngineFetch | undefined,
): Promise<AcquiredEngine> {
  // Normalized (and refused if malformed) before it keys anything: `0.1.5` and
  // `v0.1.5` are one entry, and `../x` never reaches a path or a request.
  const pinned =
    requested === undefined || requested === "latest" ? undefined : normalizeEngineVersion(requested);
  const cacheByVersion = !usesCustomReleaseManager(env);

  if (pinned !== undefined && cacheByVersion) {
    const hit = readEngineEntry({ version: pinned }, env);
    if (hit !== undefined) {
      verifiedEngineExecutable(hit, env);
      return { entry: hit, version: pinned };
    }
  }

  let asset: EngineReleaseAsset;
  try {
    asset = await resolveEngineRelease({
      ...(pinned === undefined ? {} : { version: pinned }),
      platform,
      env,
      ...(fetch === undefined ? {} : { fetch }),
    });
  } catch (err) {
    // A pinned version the machine lacks has to say WHICH version it could not
    // get, and that getting it is one download — "the release manager could
    // not be reached" alone reads like the deploy needs the network forever.
    const message = (err as Error).message;
    if (pinned === undefined || message.includes(pinned)) throw err;
    const wrapped = new Error(
      `Engine ${pinned} is not cached on this machine, and getting it needs one download:\n${message}`,
      { cause: err },
    );
    // The lookup's own exit code survives the rewording: a server error (5xx)
    // is exit 8, as the unwrapped one is (E2E pass 28: this wrapper exited 1).
    const exitCode = (err as { exitCode?: unknown }).exitCode;
    if (typeof exitCode === "number") Object.defineProperty(wrapped, "exitCode", { value: exitCode, enumerable: true });
    throw wrapped;
  }

  const cached = cacheByVersion ? readEngineEntry({ version: asset.version }, env) : undefined;
  if (cached !== undefined) {
    verifiedEngineExecutable(cached, env);
    return { entry: cached, version: asset.version };
  }

  // No credential, whatever the environment holds: the release is public, and
  // the manual redirect walk keeps even that choice off the storage host.
  const res = await fetchFollowingRedirects(asset.downloadUrl, {
    token: undefined,
    fetch: fetch ?? defaultFetch,
    release: asset.version,
  });
  if (!res.ok) throw releaseDownloadRefusal(res.status, asset.version);
  const archive = new Uint8Array(await res.arrayBuffer());

  // Compared BEFORE anything reaches the cache path. The release's recorded
  // digest is the authority here, so a disagreement is a refusal and no sidecar
  // is consulted to second-guess it.
  const archiveDigest = sha256Hex(archive);
  if (archiveDigest !== asset.sha256) {
    throw new Error(
      `The engine ${asset.version} archive's sha256 disagrees with the one its release ` +
        `recorded, so nothing was written.\n` +
        `Re-run to rule out a truncated download; if it disagrees again, the archive is not the ` +
        `one the release published and should not be run.`,
    );
  }

  const executable = extractEngineExecutable(archive, { release: asset.version });
  const entry = stageEngine({
    url: asset.downloadUrl,
    ...(cacheByVersion ? { version: asset.version } : {}),
    executable,
    digest: sha256Hex(executable),
    archiveDigest,
    env,
  });
  verifiedEngineExecutable(entry, env);
  return { entry, version: asset.version };
}

/**
 * An override the operator named: a URL to fetch, or an archive path to read.
 * Staged under its own `src-<hash>` namespace, never under a version.
 */
async function acquireOverride(
  source: string,
  env: NodeJS.ProcessEnv,
  fetch: EngineFetch,
): Promise<EngineCacheEntry> {
  // A local archive is the one source whose CONTENTS change under a stable
  // identity: a tester who downloads a newer engine over the same path would
  // otherwise keep running the old one forever, because the cache is keyed by
  // the source. So the file is read and hashed first — milliseconds on ~61MB —
  // and the cache is a hit only when those bytes are the ones it was staged
  // from. A URL is not re-fetched to ask the same question: re-reading it is a
  // download, which is the cost the cache exists to avoid.
  if (!isDownloadUrl(source)) {
    const path = resolveArchivePath(source, env);
    const archive = readArchiveFile(path);
    const archiveDigest = sha256Hex(archive);

    const cached = readEngineEntry({ source: path }, env);
    if (cached !== undefined && cached.archiveDigest === archiveDigest) {
      verifiedEngineExecutable(cached, env);
      return cached;
    }

    // Everything below here is the same pipeline the download takes — extract,
    // digest, stage, re-verify — deliberately shared rather than mirrored.
    const executable = extractEngineExecutable(archive);
    const staged = stageEngine({
      url: path,
      executable,
      digest: sha256Hex(executable),
      archiveDigest,
      env,
    });
    verifiedEngineExecutable(staged, env);
    return staged;
  }

  const hit = readEngineEntry({ source }, env);
  if (hit !== undefined) {
    verifiedEngineExecutable(hit, env);
    return hit;
  }

  const url = source;
  // The command refuses this as a usage error first; held here too so no
  // caller can reach the network with a cleartext engine (or its credential).
  if (!isTrustedEngineUrl(url)) {
    throw new Error(
      `The engine download URL is plain http on a host that is not this machine, so nothing was ` +
        `requested.\nServe the archive over https://, or over http:// from loopback.`,
    );
  }
  const rawToken = readEnvVar(LOCAL_ENGINE_TOKEN_ENV, env);
  registerSecret(rawToken);
  const token = rawToken?.trim();
  const problem = token === undefined ? undefined : tokenTextProblem(token);
  if (problem !== undefined) {
    throw new UsageError(
      `\`${LOCAL_ENGINE_TOKEN_ENV}\` in the environment ${problem}, which no request can carry, so nothing ` +
        `was requested. Set it to the token alone — one line, nothing else.`,
    );
  }
  const res = await fetchFollowingRedirects(url, { token, fetch });
  if (!res.ok) throw downloadRefusal(res.status, token !== undefined);
  const archive = new Uint8Array(await res.arrayBuffer());

  // Digested BEFORE anything reaches the cache path, so the cross-check below
  // can refuse without having written a byte.
  const archiveDigest = sha256Hex(archive);
  const published = await publishedChecksum(url, { token, fetch });
  if (published !== undefined && published !== archiveDigest) {
    throw new Error(
      `The engine archive's bytes disagree with the checksum published beside it, so nothing ` +
        `was written.\n` +
        `Re-run to rule out a truncated download; if it disagrees again, the artifact is not ` +
        `the one the release recorded and should not be run.`,
    );
  }

  const executable = extractEngineExecutable(archive);
  const entry = stageEngine({
    url,
    executable,
    digest: sha256Hex(executable),
    archiveDigest,
    env,
  });
  verifiedEngineExecutable(entry, env);
  return entry;
}
