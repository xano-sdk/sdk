/**
 * Node-only static-host deploy: archive a local directory and POST it to the
 * static-host build endpoint, which ingests the build AND deploys it to the `dev`
 * environment in one call.
 *
 * TARGET — whichever environment the caller passes, addressed by base URL and
 * workspace id. `deploy` sends the ephemeral it just imported into, so backend
 * and frontend share one disposable environment. Requests carry the caller's
 * ordinary OAuth bearer — no impersonation, no `X-Tenant` routing.
 *
 * The `api:meta` build route keys the host by NAME and auto-creates a `default`
 * host when the workspace has none, so a single call suffices — no lookup step:
 *
 *   `POST /api:meta/workspace/{id}/static_host/default/build`  (multipart) -> URLs
 *
 * Unlike the `mvp-admin` build route, the meta route auto-deploys to `dev` and
 * returns the live URL (`default_url`/`custom_url`). Matches the reference
 * `xano static_host build push` CLI.
 *
 * Archive format: a gzipped USTAR tarball, built dependency-free (the SDK stays
 * lean). The build endpoint dispatches on the uploaded filename's extension and
 * accepts `.tar.gz` (verified against the Xano engine's static-hosting build);
 * we upload as `build.tar.gz`.
 *
 * Node-only (`node:fs`/`node:zlib`) and lazily imported so the browser-safe
 * authoring bundle never pulls it in.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tarGz as sharedTarGz } from "../util/tar.js";
import {
  fetchOrExplain,
  httpFailure,
  parseJsonAnswer,
  SENT_AFTERMATH,
  serverMessage,
  unexpectedAnswerError,
  withWriteStatusAftermath,
} from "../util/http.js";
import { writeTransportFailure } from "./answer-shape.js";
import { isServerPath, SERVER_BUNDLE, SERVER_ENV } from "./server-bundle.js";

const STATIC_TIMEOUT_MS = 120_000;
/** Client-side archive cap — the static upload is a second attacker-influenced payload path. */
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

interface ArchiveEntry {
  /** POSIX-separated path relative to the archived directory root. */
  path: string;
  data: Buffer;
}

/** A symlink in a build that was not followed, and why. */
export interface SkippedLink {
  /** POSIX-relative path of the link. */
  path: string;
  reason: "outside" | "broken";
}

/**
 * Recursively collect the files under `dir` with POSIX-relative paths,
 * following symlinks whose target stays inside `dir` (a link out of the build,
 * or to nothing, is listed in `links` instead). `server: false` leaves out the
 * server half (`.xano-ssr/`, see `server-bundle.ts`).
 */
function scanFiles(dir: string, opts: { server?: boolean } = {}): { files: ArchiveEntry[]; links: SkippedLink[] } {
  const files: ArchiveEntry[] = [];
  const links = walkBuild(dir, opts, (path, full) => files.push({ path, data: readFileSync(full) }));
  return { files, links };
}

/** The walk behind {@link scanFiles}: calls `onFile` for each file the upload carries and returns the links it left out. */
function walkBuild(dir: string, opts: { server?: boolean }, onFile: (path: string, full: string) => void): SkippedLink[] {
  const links: SkippedLink[] = [];
  const root = realpathSync(dir);
  const inside = (real: string): boolean => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
  const visiting = new Set<string>();
  const walk = (cur: string, real: string): void => {
    if (visiting.has(real)) return; // a link back up the tree
    visiting.add(real);
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, ent.name);
      const path = relative(dir, full).split(sep).join("/");
      if (opts.server === false && isServerPath(path)) continue;
      if (ent.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(full);
        } catch {
          links.push({ path, reason: "broken" });
          continue;
        }
        if (!inside(target)) {
          links.push({ path, reason: "outside" });
          continue;
        }
        const st = statSync(target);
        if (st.isDirectory()) walk(full, target);
        else if (st.isFile()) onFile(path, full);
      } else if (ent.isDirectory()) walk(full, join(real, ent.name));
      else if (ent.isFile()) onFile(path, full);
    }
    visiting.delete(real);
  };
  walk(dir, root);
  return links;
}

function collectFiles(dir: string, opts: { server?: boolean } = {}): ArchiveEntry[] {
  return scanFiles(dir, opts).files;
}

/** Dotfiles no page fetches: not worth a warning when they go unserved. */
const UNREQUESTED_DOTFILES = new Set([".DS_Store", ".gitkeep", ".gitignore", ".nojekyll"]);

/**
 * Whether a POSIX-relative build path has a dot segment — a path a static host
 * never serves — and is one a page could ask for.
 */
function isHiddenPath(path: string): boolean {
  const segs = path.split("/");
  return segs.some((seg) => seg.startsWith(".")) && !UNREQUESTED_DOTFILES.has(segs.at(-1)!);
}

/** Options for {@link assertStaticDir}. */
export interface StaticDirOptions {
  /**
   * The destination runs a build's server half (a local engine), so a build
   * with a server bundle needs no index.html: its root page may be rendered
   * rather than prerendered. Anywhere else the server half is not uploaded.
   */
  serverRendered?: boolean;
}

/**
 * Refuse a static directory that cannot be published, before anything is sent.
 *
 * Checked locally and FIRST by every caller that also writes a backend: the
 * upload runs after the import, so a directory found missing only there has
 * already cost the environment its rows and its old frontend.
 *
 * `label` names where the directory came from — `--static` on `deploy` and
 * `release`. A caller whose directory is not a flag's value (`publish <dir>`)
 * omits it, so the message never names a flag the reader did not type.
 *
 * `maxBytes` is the upload cap; only a test passes anything but the default.
 */
export function assertStaticDir(
  dir: string,
  label?: string,
  maxBytes: number = MAX_ARCHIVE_BYTES,
  opts: StaticDirOptions = {},
): void {
  const where = `${label === undefined ? "" : `${label} `}${dir}`;
  const stat = statSync(dir, { throwIfNoEntry: false });
  if (stat === undefined) throw new StaticDirError(`${where}: directory not found.`);
  if (!stat.isDirectory()) throw new StaticDirError(`${where}: not a directory.`);
  const serverRendered = opts.serverRendered === true;
  // Before any file is read: an oversize build should cost a stat per file, not its bytes in memory.
  if (serverRendered) assertWithinEngineLimits(dir, where);
  // What the upload will carry: the server half only where it is run.
  const files = collectFiles(dir, { server: serverRendered });
  if (files.length === 0) throw new StaticDirError(`${where}: no files to deploy (directory is empty).`);
  // The host takes an upload without an entry page and fails the rollout
  // afterwards — by then a `deploy --static` has already landed its backend.
  // A server-rendered build on a destination that runs it renders its root.
  // `files` holds the server half only when that destination runs it.
  const rendered = files.some((f) => f.path === SERVER_BUNDLE);
  if (!rendered && !files.some((f) => f.path === "index.html")) {
    throw new StaticDirError(
      `${where}: no index.html at its root, so the static host would have no entry page. ` +
        (existsSync(join(dir, SERVER_BUNDLE))
          ? `Its server half (${SERVER_BUNDLE}) renders pages on a local engine only (\`--local-engine\`); ` +
            `a host that serves files needs the root page prerendered.`
          : `Point it at the build output directory — the one that holds index.html.`),
    );
  }
  // The upload cap, here and not only at upload time: a build over it found
  // only then has already cost a replace its backend and its old frontend, and
  // the retry the failure prints could never succeed.
  assertArchiveFits(files, where, maxBytes);
}

/** A local engine refuses an upload with more files than this, or more unpacked bytes than {@link ENGINE_MAX_UNPACKED_BYTES}. */
const ENGINE_MAX_FILES = 20_000;
const ENGINE_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

/**
 * Refuse a build a local engine would answer 400 to, before the backend import
 * it follows has already landed. Counts the files the upload carries and their
 * sizes by stat, walking the tree as {@link scanFiles} does.
 */
function assertWithinEngineLimits(dir: string, where: string): void {
  let files = 0;
  let bytes = 0;
  walkBuild(dir, { server: true }, (_path, full) => {
    files++;
    bytes += statSync(full).size;
  });
  const advice = "Point at the build output only (not the project root or node_modules), or trim what it ships.";
  if (files > ENGINE_MAX_FILES) {
    throw new StaticDirError(
      `${where}: ${files.toLocaleString("en-US")} files, over a local engine's limit of ${ENGINE_MAX_FILES.toLocaleString("en-US")}. ${advice}`,
    );
  }
  if (bytes > ENGINE_MAX_UNPACKED_BYTES) {
    const mb = (n: number): number => Number((n / (1024 * 1024)).toFixed(2));
    throw new StaticDirError(
      `${where}: ${mb(bytes)} MB unpacked, over a local engine's limit of ${mb(ENGINE_MAX_UNPACKED_BYTES)} MB. ${advice}`,
    );
  }
}

/**
 * Refuse a build whose archive would exceed {@link MAX_ARCHIVE_BYTES}.
 *
 * Cheap for the common case: the gzipped archive is never larger than the raw
 * bytes plus the tar framing (a 512-byte header and up to 511 bytes of padding
 * per file, and the closing blocks), so a build under the cap on that bound
 * passes without compressing anything. Only one that could be over is
 * archived to measure the real size.
 */
function assertArchiveFits(files: ArchiveEntry[], where: string, maxBytes: number): void {
  const bound = files.reduce((sum, f) => sum + f.data.length + 1024, 1024);
  if (bound <= maxBytes) return;
  const size = tarGz(files).length;
  if (size > maxBytes) throw new StaticDirError(overCapMessage(where, size, maxBytes));
}

/** The over-cap refusal, in megabytes a reader can compare with their build. */
function overCapMessage(where: string, size: number, maxBytes: number = MAX_ARCHIVE_BYTES): string {
  const mb = (n: number): string => `${Number((n / (1024 * 1024)).toFixed(2))} MB`;
  return (
    `${where}: the compressed build is ${mb(size)}, over the ${mb(maxBytes)} cap for a static upload. ` +
    `Point at the build output only (not the project root or node_modules), or trim what it ships.`
  );
}

/**
 * A static directory refused by {@link assertStaticDir}: a value the caller
 * fixes by retyping it, which a CLI caller reports as a usage error. Its own
 * class so this module stays free of the CLI's error types.
 */
export class StaticDirError extends Error {
  override readonly name = "StaticDirError";
}

/** One non-public seed value found inside a built asset. */
export interface SeedLeak {
  /** POSIX-relative path of the asset within the static directory. */
  file: string;
  table: string;
  column: string;
}

/**
 * Search a built frontend for seed values the schema declares non-public.
 *
 * This is the one moment the tooling holds both halves at once — the rows about
 * to be imported and the assets about to be published — which is why the check
 * lives here rather than in a linter that would have to be told about both.
 *
 * A hit means a bundler copied a server-side value into a file that is about to
 * be served at a public URL. That is how the deferred-thunk seed form leaked
 * plaintext passwords into `dist/`; `seedFile()` closes the known
 * path, and this closes the general one — any future bundler behaviour that
 * reaches seed data still gets caught before publication rather than after.
 *
 * Matching is a plain substring: minified output rewrites identifiers but not
 * string literals, so a leaked credential survives the build verbatim, and a
 * word-boundary rule would miss it inside a concatenated chunk.
 */
export function findSeedLeaks(
  dir: string,
  values: readonly { table: string; column: string; value: string; scannable?: boolean }[],
): SeedLeak[] {
  // An unscannable value (too short, or not a string) is skipped here on
  // purpose — searching a build for "42" matches everything. It is not ignored:
  // the deploy path reports it separately so the author can judge it.
  values = values.filter((v) => v.scannable !== false);
  if (values.length === 0 || !existsSync(dir)) return [];
  const leaks: SeedLeak[] = [];
  // The server half is never served: a local engine keeps it privately and every
  // other host is not sent it. Server code reading a seed value is not a leak.
  for (const file of collectFiles(dir, { server: false })) {
    // Latin-1 rather than UTF-8: a binary asset then decodes to harmless
    // mojibake instead of replacement characters, which keeps an ASCII secret
    // findable in a file this scan cannot otherwise classify.
    const text = file.data.toString("latin1");
    // One leak per file and COLUMN, not per seed row: five demo users sharing a
    // password are one thing for the author to look at, not five lines.
    const seen = new Set<string>();
    for (const v of values) {
      const key = `${v.table}\0${v.column}`;
      if (seen.has(key) || !text.includes(v.value)) continue;
      seen.add(key);
      leaks.push({ file: file.path, table: v.table, column: v.column });
    }
  }
  return leaks;
}

/**
 * Assemble a gzipped USTAR tarball from the collected files. Exported for tests.
 * Adapts the static-host `{ path, data }` shape onto the shared {@link tarGz}
 * writer (`{ name, data }`), which owns the ustar header/checksum math.
 */
export function tarGz(files: ArchiveEntry[]): Buffer {
  return sharedTarGz(files.map((f) => ({ name: f.path, data: f.data })));
}

/**
 * How the host should resolve URLs within this build.
 *
 * `spa` — one document, every unmatched path serves it. `multipage` — the host
 * additionally tries `{path}.html` and `{path}/index.html`, and honors a root
 * `404.html` when the bundle ships one.
 */
export type StaticRouting = "spa" | "multipage";

/**
 * Classify a bundle from its file list.
 *
 * Any HTML document other than the root `index.html` means the build emitted
 * more than one page. A bundle whose only document IS the root `index.html`
 * gains nothing from multi-page resolution — every extra candidate would miss
 * and land on the same document — so it stays single-page.
 *
 * Deliberately inferred rather than asked for: a flag the agent has to know
 * about is a flag the agent will not set, and getting this wrong is invisible
 * (routes resolve to the wrong document with a 200). `--static-routing` exists
 * for the bundles this reads wrong.
 *
 * Mirrors the host's own classification. The two must agree on what a bundle is.
 *
 * @param paths POSIX-relative paths from the bundle root.
 */
export function detectRouting(paths: readonly string[]): StaticRouting {
  for (const raw of paths) {
    const path = raw.replace(/^\.?\//, "");
    if (path === "" || path.toLowerCase() === "index.html") continue;
    if (/\.html?$/i.test(path)) return "multipage";
  }
  return "spa";
}

/**
 * A build {@link detectRouting} calls multipage only for a root error page —
 * `index.html` plus `404.html` (or `200.html`) and no other document. That is
 * the shape of a single-page app that ships its own not-found page, and as
 * multipage every deep link its client router owns answers that 404.
 */
export function multipageOnlyForErrorPage(paths: readonly string[]): boolean {
  const docs = paths.map((p) => p.replace(/^\.?\//, "").toLowerCase()).filter((p) => /\.html?$/.test(p));
  return (
    docs.includes("index.html") &&
    docs.some((p) => p !== "index.html") &&
    docs.every((p) => p === "index.html" || p === "404.html" || p === "200.html")
  );
}

export interface StaticHostRequest {
  /** Local directory to archive and deploy. */
  dir: string;
  /** Numeric id of the caller's (parent) workspace — resolved from the token (see `./workspace.js`). */
  workspaceId: number;
  /** Instance origin to resolve the meta-API path against. */
  baseUrl: string;
  /** The caller's OAuth bearer token. */
  accessToken: string;
  /** Static-host NAME, used verbatim in the build path. The meta build route
   *  auto-creates it only when it is `default`. Defaults to `default`. */
  host?: string;
  /**
   * Public config baked into EVERY HTML document in the archive as `window.<KEY>`
   * globals, evaluated before the app bundle runs. The deploy layer seeds
   * `XANO_HOST` with the backend URL of the environment that was just deployed
   * to, and merges any `--static-env`.
   *
   * Every document, not just the root: a prerendered build serves a DIFFERENT
   * document per route, so injecting only `index.html` leaves every deep link
   * and refresh running with the global unset — silently, since the page still
   * renders and the app reads `""` for the backend.
   *
   * A static host has no server runtime: every value here is served to the
   * browser verbatim, so it is **public** — base URLs and publishable keys only,
   * never secrets. When no document has a `<head>` to anchor to, injection is
   * skipped and `envInjected` is false.
   */
  env?: Record<string, string>;
  /**
   * Override the routing shape instead of inferring it from the bundle. Leave
   * unset — {@link detectRouting} is right for anything a framework emits. Set
   * it for a single-document site that wants real 404s, or a bundle carrying a
   * stray `.html` that should still route client-side.
   */
  routing?: StaticRouting;
  /**
   * Where `dir` came from, for the refusals — `--static` when it is that flag's
   * value. Omitted, the messages name the directory alone. See {@link assertStaticDir}.
   */
  label?: string;
  /**
   * The destination runs a build's server half (`.xano-ssr/`, written by
   * `@xano/sdk/sveltekit`): a local engine. Anywhere else the server half is
   * left out of the upload, since a host that serves files only would never
   * run it and it may hold the app's private build-time env.
   */
  serverRendered?: boolean;
}

export interface StaticHostResult {
  /** The deployed build's live URL, if the endpoint reports one. */
  url: string | undefined;
  /**
   * Canonical of the build this call just created — the token the static server
   * stamps on `X-Xano-Canonical` for the build it is actually serving. Used to
   * verify *this* build went live (see `verify-rollout.js`). `undefined` when the
   * response doesn't carry one (older engine / unexpected shape), which the
   * caller treats as "skip verification and report as before".
   */
  canonical: string | undefined;
  /** True when `env` was non-empty AND at least one document received the config script. */
  envInjected: boolean;
  /** How many HTML documents received the config script (0 when `env` was empty). */
  envDocuments: number;
  /**
   * POSIX-relative paths of HTML documents that were NOT injected because they
   * carry no `<head>`. Non-empty means those routes run with the globals unset,
   * which the deploy layer reports — the failure is otherwise invisible.
   */
  envSkipped: string[];
  /** The routing shape declared for this build — inferred, or the caller's override. */
  routing: StaticRouting;
  /** Inferred multipage for a build that looks single-page (see {@link multipageOnlyForErrorPage}). */
  routingSuspect?: true;
  /** With {@link routingSuspect}: the root pages beside `index.html` the inference rests on (`404.html`, `200.html`). */
  routingSuspectPages?: string[];
  /**
   * What happened to the build's server half: `uploaded` for a destination that
   * runs it, `omitted` for one that serves files only. Absent when the build has none.
   */
  serverBundle?: "uploaded" | "omitted";
  /**
   * Uploaded files under a dot segment (`.well-known/…`), which a host that
   * serves files never serves. Absent where the destination runs the build.
   */
  hiddenUnserved?: string[];
  /** Symlinks left out of the upload: their target is outside the build, or missing. */
  skippedLinks?: SkippedLink[];
  raw: string;
}

/**
 * Pick the live URL out of the meta build response. The engine
 * emits `default_url`/`custom_url` (built as `https://{env.host|custom}`); older
 * shapes nested them under `dev` or exposed a bare `host`. Prefer a custom domain,
 * then the default URL, and prefix a bare host with https as a last resort.
 */
function pickUrl(parsed: Record<string, unknown>): string | undefined {
  const dev = parsed.dev as
    | { host?: unknown; custom?: unknown; url?: unknown; default_url?: unknown; custom_url?: unknown }
    | undefined;
  const direct = [parsed.custom_url, parsed.default_url, parsed.url, dev?.custom_url, dev?.default_url, dev?.url].find(
    (c): c is string => typeof c === "string" && c !== "",
  );
  if (direct !== undefined) return /^https?:\/\//.test(direct) ? direct : `https://${direct}`;
  const host = [dev?.custom, dev?.host].find((c): c is string => typeof c === "string" && c !== "");
  return host !== undefined ? `https://${host}` : undefined;
}

/**
 * Pick the build's canonical out of the meta build response. The engine reports
 * it as a top-level `canonical` on the build; older/nested shapes expose it under
 * the served environment (`dev.canonical`) or the build sub-object
 * (`build.canonical`) — the same shapes the reference frontend reads. Returns the
 * first non-empty string, or `undefined` so the caller degrades to no-verify.
 */
function pickCanonical(parsed: Record<string, unknown>): string | undefined {
  const dev = parsed.dev as { canonical?: unknown } | undefined;
  const build = parsed.build as { canonical?: unknown } | undefined;
  return [parsed.canonical, dev?.canonical, build?.canonical].find(
    (c): c is string => typeof c === "string" && c !== "",
  );
}

/**
 * Build the inline bootstrap `<script>` that assigns each env entry to a window
 * global. Bracket-notation assignment tolerates any key (including ones that
 * aren't valid identifiers), and `<`-escaping the whole payload keeps a
 * value that contains `</script>` from closing the element early.
 */
function envScript(env: Record<string, string>): string {
  const body = Object.entries(env)
    .map(([k, v]) => `window[${JSON.stringify(k)}]=${JSON.stringify(v)};`)
    .join("")
    .replace(/</g, "\\u003c");
  return `<script>${body}</script>`;
}

/**
 * Inject the bootstrap script at the very top of `<head>` so it runs before any
 * app bundle. Returns the rewritten HTML, or `undefined` when there is nothing
 * to anchor to (the caller then treats config as not injected).
 *
 * `<head>` is optional in HTML: a document that opens with `<title>` or `<body>`
 * has one implied, and a script before its first element is parsed into it. So
 * without an explicit `<head>`, the script goes right after the `<html>` tag, or
 * the doctype, or at the top of a document that shows it is one (E2E pass 25: a
 * page with `<title>` and no `<head>` ran with its globals unset). A fragment
 * with none of those is left alone. `<header>` is not `<head>`.
 *
 * Tags are looked for in markup only: a `<head>` inside a comment, a script, a
 * style, a `<noscript>`, a `<template>`, a CDATA section or an attribute value
 * is not a tag, and a script placed there never runs.
 */
function injectEnv(html: string, script: string): string | undefined {
  const markup = maskNonMarkup(html);
  const at = (m: RegExpExecArray | null) => (m === null ? undefined : m.index + m[0].length);
  const anchor =
    at(/<head(?=[\s>/])[^>]*>/i.exec(markup)) ??
    at(/<html(?=[\s>/])[^>]*>/i.exec(markup)) ??
    at(/^\s*<!doctype[^>]*>/i.exec(markup)) ??
    (/<(?:title|meta|link|base|body)(?=[\s>/])/i.test(markup) ? 0 : undefined);
  if (anchor === undefined) return undefined;
  return html.slice(0, anchor) + script + html.slice(anchor);
}

/**
 * `html` with everything that is not a live tag blanked to spaces, so an index
 * into it is an index into `html`: comments, CDATA sections, whole
 * `<script>`/`<style>`/`<noscript>`/`<template>` elements (their content is
 * text, or inert), and every quoted attribute value inside a tag (a `<head>`
 * written in `data-a="<head>"` is a value, and its `>` does not end the tag).
 * An unclosed construct runs to the end, as a parser reads it.
 */
function maskNonMarkup(html: string): string {
  return html.replace(
    /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<(script|style|noscript|template)(?=[\s>/])[\s\S]*?(?:<\/\1\s*>|$)|<[a-z][^\s/>]*(?:"[^"]*"|'[^']*'|[^'">])*>?/gi,
    (m, element: string | undefined) =>
      element !== undefined || m.startsWith("<!")
        ? " ".repeat(m.length)
        : m.replace(/"[^"]*"|'[^']*'/g, (q) => `${q[0]}${" ".repeat(q.length - 2)}${q[0]}`),
  );
}

/**
 * Archive `dir` and POST it to the meta static-host build endpoint for the given
 * (parent) workspace. The route auto-creates the `default` host and auto-deploys
 * to `dev`, returning the live URL — a single call, no lookup or publish step.
 */
export async function deployStaticHost(req: StaticHostRequest): Promise<StaticHostResult> {
  const serverRendered = req.serverRendered === true;
  assertStaticDir(req.dir, req.label, MAX_ARCHIVE_BYTES, { serverRendered });
  const { files, links } = scanFiles(req.dir, { server: serverRendered });
  const hidden = serverRendered ? [] : files.map((f) => f.path).filter(isHiddenPath);
  const hasServer = existsSync(join(req.dir, SERVER_BUNDLE));

  // Bake public config into EVERY document as window.<KEY> globals. Not just the
  // root: a prerendered build serves a different document per route, so a
  // root-only inject leaves every deep link and refresh with the globals unset —
  // and the page still renders, so nothing reports it. Skipped (envInjected
  // stays false) when there is no config or no document has a <head> to anchor to.
  const envSkipped: string[] = [];
  let envDocuments = 0;
  const env = req.env ?? {};
  if (Object.keys(env).length > 0) {
    const script = envScript(env);
    for (const file of files) {
      if (!/\.html?$/i.test(file.path) || isServerPath(file.path)) continue;
      const rewritten = injectEnv(file.data.toString("utf8"), script);
      if (rewritten === undefined) {
        envSkipped.push(file.path);
        continue;
      }
      file.data = Buffer.from(rewritten, "utf8");
      envDocuments++;
    }
  }

  // Where the server half runs, a rendered page needs the same config the
  // documents above were given: the engine injects it from this file.
  if (serverRendered && hasServer && Object.keys(env).length > 0) {
    const i = files.findIndex((f) => f.path === SERVER_ENV);
    if (i >= 0) files.splice(i, 1);
    files.push({ path: SERVER_ENV, data: Buffer.from(JSON.stringify(env), "utf8") });
  }

  const archive = tarGz(files);
  // The backstop: `assertStaticDir` refused an over-cap build before any write,
  // and only the injected config can have grown it since.
  if (archive.length > MAX_ARCHIVE_BYTES) {
    throw new StaticDirError(overCapMessage(`${req.label === undefined ? "" : `${req.label} `}${req.dir}`, archive.length));
  }

  // Declared, not guessed at serve time: the host defaults anything it does not
  // understand to single-page, so an unsent value silently means "spa".
  const servedPaths = files.filter((f) => !isServerPath(f.path)).map((f) => f.path);
  const routing = req.routing ?? detectRouting(servedPaths);
  // Not suspect from the SDK's SvelteKit adapter (it ships a server half): its
  // 404.html is the prerendered /404 page or the app shell that boots every
  // route the build has no file for, so multipage is right either way.
  const routingSuspect =
    req.routing === undefined && routing === "multipage" && !hasServer && multipageOnlyForErrorPage(servedPaths);

  const host = req.host ?? "default";
  // String-concatenate (not `new URL(absolutePath, base)`) so a base URL carrying a
  // `/tenant/{name}` path prefix survives — an absolute path discards it and the
  // POST lands on the parent instance's workspace 1 (404 "Invalid workspace").
  // Mirrors `import.js`, which targets the same tenant base URL.
  const url = `${req.baseUrl.replace(/\/$/, "")}/api:meta/workspace/${req.workspaceId}/static_host/${encodeURIComponent(host)}/build`;
  const form = new FormData();
  form.append("name", "xanosdk-deploy");
  form.append("routing", routing);
  form.append("file", new Blob([archive], { type: "application/gzip" }), "build.tar.gz");

  // A dropped connection names the host and the reason, never a bare
  // `fetch failed` — and never the route. A write, so either drop says what it
  // means for the build: a connection refused sent nothing; one lost after it
  // was sent (at connect or mid-answer) may or may not have published.
  const res = await fetchOrExplain(
    url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${req.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(STATIC_TIMEOUT_MS),
    },
    "Static-host build",
    STATIC_TIMEOUT_MS,
  ).catch((err: unknown) => {
    throw writeTransportFailure(err);
  });
  const text = await res.text().catch((err: unknown) => {
    throw writeTransportFailure(err);
  });
  if (!res.ok) {
    // The build route answers a host NAME it does not hold with a bare 500
    // "Invalid host" — it auto-creates only `default`. That is a name that is
    // not there, not a server fault, so it is answered as one: not found.
    if (serverMessage(text) === "Invalid host") {
      throw new StaticHostNotFoundError(host, await listStaticHostNames(req).catch(() => undefined));
    }
    // A build replaces the host's whole: the route's own failure published
    // nothing, and only a gateway's 502/503/504 leaves it unknown. The status
    // travels on the error for a caller that explains one (a local engine too
    // old to host static sites answers 501).
    throw Object.assign(
      new Error(withWriteStatusAftermath(httpFailure("Static-host build", res, text), res.status, undefined, { atomic: true })),
      { status: res.status },
    );
  }
  // A 200 that is not JSON is not the build route answering (a proxy, a
  // captive portal): nothing says the build landed, so it is not reported as one.
  // A write, so the refusal says what an unreadable answer means for it.
  const answer = parseJsonAnswer(text, "Static-host build", url, { aftermath: SENT_AFTERMATH });
  const parsed = (answer !== null && typeof answer === "object" && !Array.isArray(answer) ? answer : {}) as Record<string, unknown>;
  // A build answer carries the URL it serves at. JSON without one is not the
  // build route answering, and a success reported off it had no address and no
  // evidence anything was published.
  const live = pickUrl(parsed);
  if (live === undefined) throw unexpectedAnswerError("Static-host build", text, url, { aftermath: SENT_AFTERMATH });
  return {
    url: live,
    canonical: pickCanonical(parsed),
    envInjected: envDocuments > 0,
    envDocuments,
    envSkipped,
    routing,
    ...(routingSuspect
      ? {
          routingSuspect: true as const,
          routingSuspectPages: servedPaths
            .map((p) => p.replace(/^\.?\//, ""))
            .filter((p) => /\.html?$/i.test(p) && p.toLowerCase() !== "index.html"),
        }
      : {}),
    ...(hasServer ? { serverBundle: serverRendered ? ("uploaded" as const) : ("omitted" as const) } : {}),
    ...(hidden.length > 0 ? { hiddenUnserved: hidden } : {}),
    ...(links.length > 0 ? { skippedLinks: links } : {}),
    raw: text,
  };
}

/**
 * A `--static-host` name the target workspace holds no host by. Exit 8, the
 * code every named thing that is not there answers with: the flag was typed as
 * meant, and the workspace said no. `names` lists the hosts it does hold, when
 * they could be read.
 */
export class StaticHostNotFoundError extends Error {
  override readonly name = "StaticHostNotFoundError";
  readonly exitCode = 8;
  constructor(
    readonly host: string,
    readonly names: readonly string[] | undefined,
    /**
     * What did not happen, as the refusing caller knows it. The upload itself
     * published nothing; a check made before a deploy's import deployed
     * nothing either, and says so.
     */
    outcome = "Nothing was published.",
  ) {
    super(
      `No static host named "${host}" exists on the target` +
        (names === undefined
          ? ""
          : names.length === 0
            ? " — it has none yet"
            : ` — its hosts are ${names.map((n) => `"${n}"`).join(", ")}`) +
        `. Only \`default\` is created on first publish: drop \`--static-host\` to publish to it, or name ` +
        `a host that exists (created in the Xano dashboard's static hosting). ${outcome}`,
    );
  }
}

/** Where a static-host read goes: an environment's base URL, its workspace, and the bearer. */
export interface StaticHostReadTarget {
  baseUrl: string;
  workspaceId: number;
  accessToken: string;
}

/** One frontend a static host serves: the host's name and the URL it answers at. */
export interface ServingStaticHost {
  host: string;
  url: string;
}

const STATIC_READ_TIMEOUT_MS = 20_000;

/** The raw static-host rows of a workspace, every page. */
async function readStaticHostRows(req: StaticHostReadTarget): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  // Concatenated, as the build route is: the base may carry a `/tenant/{name}`
  // path prefix that `new URL(path, base)` would discard.
  const root = `${req.baseUrl.replace(/\/$/, "")}/api:meta/workspace/${req.workspaceId}/static_host`;
  // 100 hosts a page, and a bounded walk: a list that never ends is not read forever.
  for (let page = 1; page <= 10; page++) {
    const res = await fetchOrExplain(
      `${root}?page=${page}`,
      {
        headers: { Authorization: `Bearer ${req.accessToken}` },
        signal: AbortSignal.timeout(STATIC_READ_TIMEOUT_MS),
      },
      "Reading the static hosts",
      STATIC_READ_TIMEOUT_MS,
    );
    const text = await res.text();
    if (!res.ok) throw new Error(httpFailure("Reading the static hosts", res, text));
    const parsed = (parseJsonAnswer(text, "Reading the static hosts", root) ?? {}) as { items?: unknown; nextPage?: unknown };
    if (!Array.isArray(parsed.items)) throw new Error("Reading the static hosts: the answer carried no list.");
    for (const item of parsed.items) {
      if (item !== null && typeof item === "object") rows.push(item as Record<string, unknown>);
    }
    if (typeof parsed.nextPage !== "number") break;
  }
  return rows;
}

/** The names of every static host the workspace holds. Throws when the read fails. */
export async function listStaticHostNames(req: StaticHostReadTarget): Promise<string[]> {
  const rows = await readStaticHostRows(req);
  return rows.map((r) => r.name).filter((n): n is string => typeof n === "string" && n !== "");
}

/**
 * The frontends a workspace's static hosting SERVES right now, read from the
 * platform rather than from anything this project remembers.
 *
 * A replacing import clears every static host in the workspace it lands in, so
 * this is what a replace is about to take down — including a frontend another
 * project, or the dashboard, published there. A host environment serves once a
 * build was deployed to it, which is when it gets a URL; a host nobody
 * published to serves nothing.
 *
 * Throws when the read fails: an unread workspace is not an empty one, and the
 * caller decides what it may say instead.
 */
export async function listServingStaticHosts(req: StaticHostReadTarget): Promise<ServingStaticHost[]> {
  const serving: ServingStaticHost[] = [];
  for (const row of await readStaticHostRows(req)) {
    const host = typeof row.name === "string" ? row.name : "";
    for (const env of [row.dev, row.prod]) {
      if (env === null || typeof env !== "object") continue;
      const url = pickUrl(env as Record<string, unknown>);
      if (url !== undefined && !serving.some((s) => s.url === url)) serving.push({ host, url });
    }
  }
  return serving;
}
