/**
 * Node-only transport for the release object on the meta API: list, get,
 * create, import, export, deploy, delete.
 *
 * A release is the server's durable record of a backend that came up — named,
 * listable, exportable, and landable into a workspace or onto a tenant. This
 * module speaks those routes and nothing else; deciding what may be cut from
 * what, and confirming before a landing, belongs to the commands above it.
 *
 * **Everything is projected.** The raw release record carries the storage path
 * of its stored resource, and that path embeds the workspace's display name,
 * alongside the resource's size and signature. None of it helps a caller and
 * all of it lands in shell history and CI logs, so {@link ReleaseSummary} is
 * what leaves this module — on the failure path as well as the success path,
 * via {@link safeHttpFailure}.
 *
 * Two identifier shapes are in play and are not interchangeable, which is a
 * property of the routes rather than a choice made here: a release is fetched
 * and deleted by numeric id, and deployed by name.
 *
 * Follows the SDK's fetch conventions: `new URL(path, auth.instance)`, a bearer
 * header, and an `AbortSignal.timeout` bound.
 *
 * **Reads retry, writes do not.** Every GET here — list, get, the export link,
 * the archive behind it, the multidoc — goes through {@link metaRead}, which
 * retries a dropped connection. Those are the reads that settle an interrupted
 * write, so they have to survive the same blip that interrupted it. The writes
 * go through {@link metaWrite} and get exactly one attempt: a cut or a landing
 * is not atomic from here, and a second attempt can apply it twice. Two
 * functions rather than a flag, so a write cannot opt into retries by passing
 * the wrong argument.
 */
import type { ResolvedAuth } from "../auth/token.js";
import { asTimestamp } from "../util/timestamp.js";
import {
  explainFetchFailure,
  fetchOrExplain,
  fetchReadOrExplain,
  retryingFetch,
  safeHttpFailure,
  statusLabel,
  type BindingContext,
  parseJsonAnswer,
  writeStatusAftermath,
} from "../util/http.js";

/** Bound each call so a stalled endpoint cannot hang the CLI or CI. */
const TIMEOUT_MS = 30_000;

/**
 * A release route that answered, and answered with a failure.
 *
 * Typed so a caller can read the STATUS without parsing a sentence: a 4xx on a
 * write means the server refused it and nothing landed, a 5xx means the server
 * may have done some or all of it before failing. That difference is what
 * decides whether a failed cut can be retried or must be looked up first.
 *
 * The message is {@link safeHttpFailure}'s, unchanged, and the body is not kept:
 * these routes reach real workspaces, so an unlabelled body stays unprinted
 * wherever this error ends up.
 */
export class ReleaseHttpError extends Error {
  constructor(
    readonly status: number,
    action: string,
    statusText: string,
    body: string,
    bind?: BindingContext,
    /** A line under the status — a write's {@link writeStatusAftermath}. */
    aftermath?: string,
  ) {
    const head = safeHttpFailure(action, { status, statusText }, body, bind);
    super(aftermath === undefined ? head : `${head}\n${aftermath}`);
    this.name = "ReleaseHttpError";
  }
}
/**
 * The bound for a long-running WRITE, in minutes rather than seconds. Two paths
 * need it and neither is the other's: a landing rebuilds a branch, and a cut
 * carrying table rows streams them into the archive inside the create request.
 * Shared because the shape of the wait is the same, not by coincidence — retune
 * it for one and you have retuned it for both.
 */
const DEPLOY_TIMEOUT_MS = 600_000;

/** One table a release carries, as the manifest names it. */
export interface SeededTable {
  name: string;
  /**
   * The table's guid, as the manifest recorded it.
   *
   * `undefined` only if a server stops sending it — every manifest row carries
   * one today. This is the identifier to compare a requested selection against:
   * the selection was made BY guid, and a table renamed between the listing and
   * the cut changes its name but not this.
   */
  guid: string | undefined;
  /** Row count the manifest recorded, when it recorded one. */
  count: number | undefined;
}

/** The projected, safe-to-print view of a release. Never the raw record. */
export interface ReleaseSummary {
  id: number | undefined;
  name: string;
  /**
   * The description the release was cut with, exactly as the server reports it.
   *
   * `""` is a REAL answer — the server's spelling of "none was set" — and is
   * kept as one. `undefined` means the server did not report the field at all,
   * which no release route does today. The distinction exists so a caller
   * reading a description back as provenance can tell an empty one from a
   * missing report rather than reading both as absent.
   */
  description: string | undefined;
  /**
   * The branch the release was cut from, or `null` when the record names none.
   *
   * A cut from an environment (an ephemeral, a sandbox) has no branch: the
   * server stores `""` for it, as it did for an old default workspace cut that
   * sent an empty label. Neither is a branch a caller can address, so both read
   * as `null` — the value every operation document uses for "no branch applies"
   * — rather than a blank label a script would try to use. `undefined` is kept
   * for a record that did not report the field at all.
   */
  branch: string | null | undefined;
  hotfix: boolean;
  /**
   * Tables whose ROWS the release carries, with the row count each recorded.
   *
   * NOT the tables in the release. A release always carries the schema of every
   * table in the workspace — that export is unconditional. This list is the
   * subset whose rows were asked for via `tableIds`, so an EMPTY list means "no
   * rows were requested", never "no tables".
   */
  seededTables: SeededTable[];
  createdAt: string | undefined;
  /**
   * Whether the server holds a stored resource for this release.
   *
   * A boolean rather than the path, because the path embeds the workspace's
   * display name. The signal still has to survive projection: a release that
   * exists but whose resource is gone is a different failure from a release
   * that was never cut, and the fixes are a re-cut and a typo respectively.
   */
  hasResource: boolean;
  /**
   * The size in bytes of the archive as it was UPLOADED — not necessarily what a
   * download returns. Measured: the import route stores an archive
   * decompressed and records the upload's size, so an imported release reports
   * its `.tar.gz` size and downloads as the larger bare tar. Not an identity:
   * two copies of one release can report different sizes.
   *
   * `undefined` when the route sends no size, AND when it sends zero — what a
   * release whose archive is gone reports.
   *
   * Optional in the type so a hand-built summary need not invent one.
   */
  resourceSize?: number | undefined;
  /**
   * The environment the release was cut from, as the SDK recorded it in the
   * description at cut time (see {@link ORIGIN_MARKER}); absent for a branch
   * cut and for a release cut elsewhere. {@link description} is reported with
   * that line removed.
   */
  recordedOrigin?: RecordedOrigin;
  /**
   * The release this one is a copy of, as `release transfer` recorded it in
   * the description (see {@link COPY_MARKER}). An import tags the copy with a
   * branch of its own, which names no source. {@link description} is reported
   * with the recorded lines removed.
   */
  copiedFrom?: CopiedFrom;
}

/** An environment a release was cut from: its type and its name. */
export interface RecordedOrigin {
  /** `ephemeral`, `sandbox`, or `environment` when the type was not known. */
  type: string;
  name: string;
}

/** Where a copied release came from: the release it was copied from, and where that one was cut. */
export interface CopiedFrom {
  /** The release the transfer read, on the instance host and workspace it read it from. */
  source: { host: string; workspaceId: number; release: string };
  /**
   * Where the copied release was cut: an environment (`type` its kind), or a
   * branch (`type: "branch"`, `name` its label). Absent when the source
   * recorded neither.
   */
  cut?: RecordedOrigin;
}

/**
 * The line an environment cut appends to its release's description, naming
 * the environment.
 *
 * The record the release routes keep has no source field — an environment cut
 * stores an empty branch — and the audit entry that names the source is pruned
 * with the log. The description is the one free field the record keeps for as
 * long as the release exists, so the origin is written there, on its own last
 * line, and parsed back off by {@link projectRelease}.
 */
export const ORIGIN_MARKER = "[xanosdk] cut from";

/**
 * The line `release transfer` appends to the copy's description, after the
 * import: the import keeps no description, so without it a copy reads as a cut
 * from the branch the import tags it with.
 */
export const COPY_MARKER = "[xanosdk] copied from";

/**
 * The prefix every line the CLI writes into a description starts with. A
 * description the author passes may not carry it, so a recorded line is
 * always one the CLI wrote.
 */
export const RESERVED_DESCRIPTION_PREFIX = "[xanosdk]";

const ORIGIN_LINE = /(?:^|\n\n)\[xanosdk\] cut from ([a-z]+) "([^"\n]+)"\s*$/;
const CUT_LINE = /^\[xanosdk\] cut from ([a-z]+) "([^"\n]+)"$/;
const COPY_LINE = /^\[xanosdk\] copied from release ("(?:[^"\\\n]|\\.)*") of workspace (\d+) on ([^\s"]+)$/;

/** The first line of a description an author passed that starts with the reserved prefix, or `undefined`. */
export function reservedDescriptionLine(description: string): string | undefined {
  return description.split(/\r?\n|\r/).find((l) => l.trimStart().startsWith(RESERVED_DESCRIPTION_PREFIX));
}

/** `description` with the origin line appended (the whole description when none was given). */
export function describeWithOrigin(description: string | undefined, origin: RecordedOrigin): string {
  const line = `${ORIGIN_MARKER} ${origin.type} ${JSON.stringify(origin.name)}`;
  return description === undefined || description === "" ? line : `${description}\n\n${line}`;
}

/**
 * A copy's description: what the author wrote, then — on the last lines —
 * where the release was cut (when known) and the release it was copied from.
 */
export function describeAsCopy(description: string | undefined, copied: CopiedFrom): string {
  const { host, workspaceId, release } = copied.source;
  const lines = [
    ...(copied.cut === undefined ? [] : [`${ORIGIN_MARKER} ${copied.cut.type} ${JSON.stringify(copied.cut.name)}`]),
    `${COPY_MARKER} release ${JSON.stringify(release)} of workspace ${workspaceId} on ${host}`,
  ].join("\n");
  return description === undefined || description === "" ? lines : `${description}\n\n${lines}`;
}

/** Split a stored description into what the author wrote and the origin line, when it carries one. */
export function splitRecordedOrigin(description: string | undefined): {
  description: string | undefined;
  origin?: RecordedOrigin;
} {
  if (description === undefined) return { description };
  const m = ORIGIN_LINE.exec(description);
  if (m === null || m[1] === "branch") return { description };
  return { description: description.slice(0, m.index), origin: { type: m[1]!, name: m[2]! } };
}

/**
 * Split a stored description into what the author wrote and the copy record
 * {@link describeAsCopy} appended, when it carries one: the copy line last,
 * the cut line directly above it, and a blank line (or nothing) above those.
 */
export function splitCopiedFrom(description: string | undefined): {
  description: string | undefined;
  copiedFrom?: CopiedFrom;
} {
  if (description === undefined) return { description };
  const lines = description.replace(/\s+$/, "").split("\n");
  const copy = COPY_LINE.exec(lines[lines.length - 1] ?? "");
  if (copy === null) return { description };
  let release: unknown;
  try {
    release = JSON.parse(copy[1]!);
  } catch {
    return { description };
  }
  if (typeof release !== "string") return { description };
  let at = lines.length - 1;
  const cutMatch = at > 0 ? CUT_LINE.exec(lines[at - 1]!) : null;
  if (cutMatch !== null) at--;
  if (at > 0 && lines[at - 1] !== "") return { description };
  const source = { host: copy[3]!, workspaceId: Number(copy[2]), release };
  return {
    description: lines.slice(0, Math.max(at - 1, 0)).join("\n"),
    copiedFrom: { source, ...(cutMatch === null ? {} : { cut: { type: cutMatch[1]!, name: cutMatch[2]! } }) },
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * A string the server REPORTED, empty or not.
 *
 * {@link asString} folds `""` into `undefined`, which is right for a field
 * whose empty spelling carries no information — a resource path, a manifest
 * row's guid. It is wrong for the two fields a caller reads back as
 * PROVENANCE, `description` and `branch`: the server always sends both keys
 * and spells "nothing was set" as `""`, so folding it makes "the server says
 * this release has none" and "the server did not report the field" the same
 * answer. A caller checking whether what it wrote came back cannot then tell a
 * release with none from a round trip that dropped one.
 *
 * `undefined` here means one thing only: the field was absent, or was not a
 * string.
 */
function asReportedString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}


/** A byte count worth comparing: a positive number, else `undefined`. */
function positiveSize(v: unknown): number | undefined {
  const n = asNumber(v);
  return n !== undefined && n > 0 ? n : undefined;
}

/**
 * Project a raw release record to the safe summary.
 *
 * Written as an allow-list rather than a delete-list: a server that starts
 * returning a new field should not start leaking it.
 */
export function projectRelease(raw: Record<string, unknown>): ReleaseSummary {
  // `raw.tables` is the server's spelling of the seeded-row manifest.
  const tables = Array.isArray(raw.tables) ? raw.tables : [];
  // The origin line is read only off an ENVIRONMENT cut — the one the SDK
  // appends it to, which stores an empty branch. A branch cut carries no such
  // line, so a `--description` of its own that happens to end in the same
  // words is the author's text, and stripping it lost it from show and list.
  // A copy is read off its own record, the one `release transfer` writes,
  // whatever branch the import tagged it with.
  const environmentCut = raw.branch === "" || raw.branch === undefined || raw.branch === null;
  const copied = splitCopiedFrom(asReportedString(raw.description));
  const described: { description: string | undefined; origin?: RecordedOrigin } =
    copied.copiedFrom !== undefined
      ? { description: copied.description }
      : environmentCut
        ? splitRecordedOrigin(asReportedString(raw.description))
        : { description: asReportedString(raw.description) };
  return {
    id: asNumber(raw.id),
    name: asString(raw.name) ?? "",
    description: described.description,
    ...(described.origin !== undefined ? { recordedOrigin: described.origin } : {}),
    ...(copied.copiedFrom !== undefined ? { copiedFrom: copied.copiedFrom } : {}),
    branch: raw.branch === "" ? null : asReportedString(raw.branch),
    hotfix: raw.hotfix === true,
    seededTables: tables.flatMap((t): SeededTable[] => {
      if (t === null || typeof t !== "object") return [];
      const row = t as Record<string, unknown>;
      const name = asString(row.name);
      // A manifest row with no name identifies nothing a caller can act on. The
      // guid IS kept — it was dropped as "an identifier we have no reason to
      // print", and selection by guid is that reason: it lets the landed-rows
      // check name the right table even across a rename.
      return name === undefined
        ? []
        : [{ name, guid: asString(row.guid), count: asNumber(row.cnt) }];
    }),
    createdAt: asTimestamp(raw.created_at),
    // No `workspaceId`: no release route reports one. The field read
    // `raw.workspace?.id` against a `workspace` object none of list, get or
    // create has ever sent, so it was always `undefined` and never appeared in
    // `--json` at all. A caller already knows the workspace — it is in the URL
    // it asked on. See `test/fixtures/release/live-records.json`.
    //
    // Either signal proves the archive is there. `resource_size` is the one the
    // routes actually send — as recorded, NO route carries `resource`, and
    // keying on the path alone reported EVERY release as having lost its
    // contents, including one cut seconds earlier. The path clause stays
    // because an engine that does send it must not be read as an empty
    // archive; it is a fallback, not the primary signal.
    hasResource: asString(raw.resource) !== undefined || (asNumber(raw.resource_size) ?? 0) > 0,
    resourceSize: positiveSize(raw.resource_size),
  };
}

/**
 * The URL and init every meta call shares.
 *
 * `base` addresses a TENANT's own meta API. A tenant serves the same routes the
 * parent workspace does — the difference is the host it answers on — so a
 * release cut from an environment is cut on that environment, not named as a
 * branch of the workspace above it.
 *
 * CONCATENATED, never resolved: a tenant without a dedicated domain is served
 * under a `/tenant/<name>` prefix on the instance origin, and
 * `new URL(path, base)` drops that prefix — which would send the call to the
 * parent instance and cut the very release this base exists to avoid.
 */
function metaRequest(
  auth: ResolvedAuth,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  base?: string,
): { url: string; init: RequestInit } {
  const url = base !== undefined ? new URL(`${base.replace(/\/$/, "")}${path}`) : new URL(path, auth.instance);
  return {
    url: url.href,
    init: {
      ...init,
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${auth.access_token}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    },
  };
}

/** A WRITE: one attempt, whatever happens to it. */
async function metaWrite(
  auth: ResolvedAuth,
  path: string,
  action: string,
  init: RequestInit,
  timeoutMs: number = TIMEOUT_MS,
  base?: string,
): Promise<Response> {
  const req = metaRequest(auth, path, init, timeoutMs, base);
  return fetchOrExplain(req.url, req.init, action, timeoutMs);
}

/**
 * A READ: a GET, retried on a dropped connection.
 *
 * Takes no `init` so nothing but a GET can come through it. The timeout bounds
 * the whole sequence, not each attempt — one signal is made and every attempt
 * shares it, so a slow instance still fails inside the budget the caller named.
 */
async function metaRead(
  auth: ResolvedAuth,
  path: string,
  action: string,
  base?: string,
): Promise<Response> {
  const req = metaRequest(auth, path, { method: "GET" }, TIMEOUT_MS, base);
  return fetchReadOrExplain(req.url, req.init, action, TIMEOUT_MS);
}

/**
 * What this call addressed, so a 403 can say whether the workspace binding is
 * what refused it. Built at the call site because only the call site knows
 * whether a tenant's own host was addressed.
 */
function binding(auth: ResolvedAuth, workspaceId: number, base?: string): BindingContext {
  return {
    boundWorkspaceId: auth.workspaceId,
    instance: auth.instance,
    profile: auth.profile,
    addressedWorkspaceId: workspaceId,
    credentialType: auth.credentialType,
    tenantHost: base !== undefined,
  };
}

async function readJson(
  res: Response,
  action: string,
  bind?: BindingContext,
): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) throw new ReleaseHttpError(res.status, action, res.statusText, text, bind);
  // Host and a summary, never the body — see `notJsonError`.
  return parseJsonAnswer(text, action, res.url, { safe: true });
}

function base(workspaceId: number): string {
  return `/api:meta/workspace/${workspaceId}/release`;
}

/**
 * The largest page the list route serves, and it is exactly the server's cap.
 *
 * Measured against a live instance:
 *
 * ```
 * per_page=25   → 25 rows, nextPage: 2
 * per_page=100  → 32 rows, nextPage: null   ← honoured
 * per_page=101  →  0 rows, nextPage: null   ← silently empty, HTTP 200
 * ```
 *
 * Over the cap the route does not refuse. It answers `200` with an EMPTY page,
 * so raising this past 100 does not make the walk slower — it makes
 * {@link listReleases} return nothing. Every caller reads through
 * {@link findRelease}, so the damage is silent and downstream: `release
 * create`'s name-collision refusal would pass a duplicate name, and `promote`,
 * `show`, `export` and `delete` would all report a release that exists as gone.
 * Do not raise it without re-measuring the cap.
 */
const PER_PAGE = 100;

/** A page's rows, whether the route answers bare or wrapped. */
function pageRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body === null || typeof body !== "object") return [];
  const items = (body as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

/**
 * The page the server says comes next, when it says.
 *
 * Three answers, not two: a number is the next page, `null` is "that was the
 * last one", and `undefined` is "this response carries no cursor at all" —
 * which is what a bare-array answer looks like, and the only case left where
 * the end of the walk has to be inferred from the row count.
 */
function nextPageOf(body: unknown): number | null | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const next = (body as { nextPage?: unknown }).nextPage;
  if (next === null) return null;
  return typeof next === "number" ? next : undefined;
}

/**
 * Every release in the workspace, newest first as the server orders them.
 *
 * Walked to exhaustion rather than read one page deep. The route paginates
 * (25 by default), and a caller that sees only the first page reports a
 * release that exists as gone — which is what `release create`'s
 * name-collision refusal and `promote`'s lookup are both built on.
 *
 * The walk follows the server's own `nextPage` cursor rather than stopping on
 * a short page. A short page was only ever a PROXY for the last one, and it is
 * a proxy that reads {@link PER_PAGE} — so it was correct exactly while that
 * constant matched a server cap it does not control. `nextPage` is the answer
 * the response already carries; the row count is the fallback for a route that
 * answers with a bare array and no envelope at all.
 */
export async function listReleases(
  auth: ResolvedAuth,
  opts: { workspaceId: number; base?: string },
): Promise<ReleaseSummary[]> {
  const out: ReleaseSummary[] = [];
  let page = 1;
  for (;;) {
    const path = `${base(opts.workspaceId)}?page=${page}&per_page=${PER_PAGE}`;
    const res = await metaRead(auth, path, "list releases", opts.base);
    const body = await readJson(res, "list releases", binding(auth, opts.workspaceId, opts.base));
    const rows = pageRows(body);
    for (const r of rows) {
      if (r !== null && typeof r === "object") out.push(projectRelease(r as Record<string, unknown>));
    }
    const next = nextPageOf(body);
    // No envelope, so no cursor: a short page is the last one, and an empty
    // first page means none exist. The fallback for the shape that gives
    // nothing better to go on.
    if (next === undefined) {
      if (rows.length < PER_PAGE) return out;
      page += 1;
      continue;
    }
    if (next === null) return out;
    // A cursor that does not advance would walk forever, re-reading one page
    // and growing `out` without bound. Trusting the server's cursor is the
    // point; trusting it to terminate is not.
    if (next <= page) return out;
    page = next;
  }
}

/**
 * One release by its numeric id, or `null` when the server holds none.
 *
 * The route a caller should reach for whenever an id is already in hand: it is
 * one request against one record, where {@link findRelease} walks every page of
 * the list to map a name onto the same thing.
 *
 * It is also the only read that survives a RENAME. A caller that writes a
 * release and then reconciles by the name it asked for is trusting the server
 * to have used that name — and the import path behind a cut can rename what it
 * just wrote, at which point the reconcile finds nothing and reports a release
 * that exists as gone. The id the write returned does not move.
 */
export async function getRelease(
  auth: ResolvedAuth,
  opts: { workspaceId: number; id: number; base?: string },
): Promise<ReleaseSummary | null> {
  const path = `${base(opts.workspaceId)}/${opts.id}`;
  const res = await metaRead(auth, path, "get release", opts.base);
  // Absent is an ANSWER here, the same as it is for `deleteRelease` — the
  // caller asked whether the server holds this id, and "no" is not a failure.
  if (res.status === 404) return null;
  const raw = await readJson(res, "get release", binding(auth, opts.workspaceId, opts.base));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`get release: the instance did not return a release record.`);
  }
  return projectRelease(raw as Record<string, unknown>);
}

/**
 * One release by name. Returns `null` when no release carries that name, so a
 * caller can tell "you have not cut this yet" from "the server refused".
 *
 * By name rather than by id because a name is what a person types; the list is
 * the only route that maps one to the other. That is the whole justification
 * for the walk — a caller that already holds an id wants {@link getRelease},
 * which is one request and does not depend on the name still being the one it
 * asked for.
 */
export async function findRelease(
  auth: ResolvedAuth,
  opts: { workspaceId: number; name: string; base?: string },
): Promise<ReleaseSummary | null> {
  const all = await listReleases(auth, opts);
  return all.find((r) => r.name === opts.name) ?? null;
}

/**
 * A release name the SDK will not send.
 *
 * Measured, not assumed: the meta API accepts `../../escaped-name` with HTTP
 * 200 and stores it verbatim. Nothing downstream re-checks it, and a release
 * name is not just a label — it is what `release export` uses as the filename,
 * so a stored name carrying `../` walks an export out of the directory it was
 * invoked from and reports the write as an ordinary success.
 *
 * This is the create-side half. It cannot be the whole fix, because a client
 * exporting releases it did not name (a CI job, an IDE) never runs it — see
 * `resolveOutputTarget`, which holds the export side independently.
 *
 * Shaped after {@link ../deploy/branch.ts}'s `assertUsableBranchLabel`: refuse,
 * and say what the name would DO, rather than printing a pattern.
 */
/** The longest release name `release create` accepts, in characters. */
export const MAX_RELEASE_NAME = 100;

export function assertUsableReleaseName(name: string): void {
  if (name.trim() === "") {
    throw new Error(
      `\`release create\` needs a name and was given an empty one.\n` +
        `The engine does not reject one — it would store a release that \`release show\`, ` +
        `\`export\` and \`promote\` all address BY NAME and so none of them could reach.`,
    );
  }
  if (name.includes("/") || name.includes("\\") || name.includes(":")) {
    throw new Error(
      `A release name cannot address a location, and "${name}" does.\n` +
        `The name is what \`xanosdk release export\` writes the file as, so a name holding ` +
        `\`/\`, \`\\\` or \`:\` would put that file somewhere nobody asked for — outside the ` +
        `directory the export was invoked from when the name also traverses up, and on another ` +
        `drive when it begins \`C:\` on Windows.\n` +
        `Name the release, and use \`--path\` on the export to choose where it lands.`,
    );
  }
  if (name.startsWith(".")) {
    throw new Error(
      `A release name cannot begin with a dot, and "${name}" does.\n` +
        `\`.\` and \`..\` address a directory rather than name one, and any other leading dot ` +
        `exports to a hidden file in the working directory that a reader will not see.`,
    );
  }
  // The engine sets no limit of its own — a 313-character name was stored, and
  // then `release export` failed with a raw ENAMETOOLONG, because the name is
  // the export's filename. A name is typed and read by people; 100 is far past
  // any real one and well inside a filename, whatever its characters.
  if ([...name].length > MAX_RELEASE_NAME) {
    throw new Error(
      `A release name can be at most ${MAX_RELEASE_NAME} characters, and this one is ${[...name].length}.\n` +
        `The name is what every release command addresses it by and what \`release export\` writes ` +
        `the file as. Pick a shorter one — put the detail in \`--description\`.`,
    );
  }
  const unpromotable = unpromotableReleasePart(name);
  if (unpromotable !== undefined) {
    throw new Error(
      `A release name cannot hold \`${unpromotable}\`, and "${name}" does.\n` +
        `It would be cut, but \`xanosdk promote\` could never land it: the route a promote lands a ` +
        `release by cannot address a name holding ${UNPROMOTABLE_RELEASE_PARTS}. ` +
        `Name it "${promotableReleaseName(name)}" instead.`,
    );
  }
  // Measured: the engine stores a tab verbatim. The release is then reachable
  // only by typing that invisible character back, prints as a gap in every
  // listing, and exports to a filename carrying it.
  if ([...name].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
    throw new Error(
      `A release name cannot carry a control character (a tab, a newline, …), and ${JSON.stringify(name)} does.\n` +
        `The engine stores it as typed, so every command that addresses the release — and the file ` +
        `\`release export\` writes — would need the same invisible character typed back.`,
    );
  }
}

/**
 * The part of a release name that `promote` cannot address, or `undefined`.
 *
 * Measured against the platform: a release is cut under any of these names,
 * but the route `promote` lands a release by takes the name in its PATH, and
 * there a `+` reads as a space and `=` finds nothing (both 404, however
 * encoded), `|` is read as a filter (400) and `..` is refused outright (400).
 * No encoding reaches them, and the numeric id is no alternative on that
 * route. `tenant deploy` sends the name in the body and lands a `+` or `..`
 * name, but not a `=` or `|` one (see {@link untenantDeployableReleasePart}).
 */
export function unpromotableReleasePart(name: string): string | undefined {
  if (name.includes("..")) return "..";
  return ["+", "=", "|"].find((ch) => name.includes(ch));
}

/**
 * The part of a release name that `tenant deploy` cannot land, or `undefined`.
 *
 * Measured: the tenant landing route takes the name in its body, yet still
 * reads `|` as a filter (400 "Invalid filter") and finds nothing for a name
 * holding `=` (404). `+` and `..` land.
 */
export function untenantDeployableReleasePart(name: string): string | undefined {
  return ["=", "|"].find((ch) => name.includes(ch));
}

/** The characters and sequence {@link unpromotableReleasePart} refuses, as a sentence lists them. */
export const UNPROMOTABLE_RELEASE_PARTS = "`+`, `=`, `|` or `..`";

/** `name` with every part `promote` cannot address replaced: `1.2.0+build7` → `1.2.0-build7`. */
export function promotableReleaseName(name: string): string {
  return name.replace(/\.{2,}/g, ".").replace(/[+=|]/g, "-");
}

/** Cut a new release from a branch of the workspace. */
export async function createRelease(
  auth: ResolvedAuth,
  opts: {
    workspaceId: number;
    name: string;
    branch: string;
    description?: string;
    hotfix?: boolean;
    /**
     * Tables whose ROWS ride along in the archive, by id. Selects rows ONLY.
     *
     * The archive exports the schema of every table in the workspace no matter
     * what this is set to — that export is unconditional and workspace-scoped
     * (tables carry no branch dimension). So omitting this does not cut a
     * release "without tables"; it cuts one without any table's rows, which is
     * the default and is usually what you want.
     *
     * An id the source does not have is silently ignored by the server, not
     * rejected — so a caller sending ids it did not read off the SOURCE's own
     * table list can get a rows-free release reported as a success. With
     * `sourceTenant` set, these are the TENANT's table ids, and a tenant's
     * workspace is always id 1, so ids read from your own workspace name
     * different tables there.
     */
    tableIds?: number[];
    /**
     * A tenant whose live state the archive is cut from, by its server-assigned
     * name. The release record still lands in `workspaceId`, and nothing is
     * written to the tenant.
     *
     * ⚠ An instance that predates this parameter DROPS it and cuts from the
     * workspace instead, answering `200` — so a caller that sets this must
     * confirm the result with {@link findReleaseSource} rather than trusting
     * the response, which carries no trace of where the bytes came from.
     *
     * With `tableIds` set, those are the TENANT's table ids, not this
     * workspace's — see that parameter.
     */
    sourceTenant?: string;
    /** A tenant's own base URL; omitted means the credential's instance. */
    base?: string;
  },
): Promise<ReleaseSummary> {
  const body: Record<string, unknown> = { name: opts.name, branch: opts.branch };
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.hotfix !== undefined) body.hotfix = opts.hotfix;
  if (opts.tableIds !== undefined) body.table_ids = opts.tableIds;
  if (opts.sourceTenant !== undefined) body.source_tenant = opts.sourceTenant;
  // The LONG budget unconditionally, not only for a rows-carrying cut. Every
  // cut exports the workspace, tars it and uploads it INSIDE this request;
  // `tableIds` adds a row-export loop on top, but it is not what makes the
  // request slow enough to matter. And the failure here is not a slow one but a
  // DUPLICATING one: the client gives up, the server finishes and creates the
  // release anyway, and the retry either collides on the name or cuts a second
  // release. Gating the budget on rows meant a big schema-only cut could trip
  // exactly that, which is the case the gate was added to prevent.
  const res = await metaWrite(
    auth,
    base(opts.workspaceId),
    "create release",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    DEPLOY_TIMEOUT_MS,
    opts.base,
  );
  return projectRelease((await readJson(res, "create release", binding(auth, opts.workspaceId, opts.base))) as Record<string, unknown>);
}

/**
 * Land a release into its workspace as a new branch.
 *
 * Additive, and measured to be so: static hosting survives, the live branch is
 * untouched unless `setLive`, and objects created after the release was cut are
 * not dropped. The one edge the server handles badly is a branch label that
 * already exists — it answers with a fatal 500 — so callers assert the branch
 * is absent before calling this rather than surfacing that.
 */
export async function deployRelease(
  auth: ResolvedAuth,
  opts: { workspaceId: number; name: string; branch?: string; setLive?: boolean },
): Promise<ReleaseSummary> {
  const body: Record<string, unknown> = { set_live: opts.setLive === true };
  if (opts.branch !== undefined) body.branch = opts.branch;
  const path = `${base(opts.workspaceId)}/${encodeURIComponent(opts.name)}/deploy`;
  const res = await metaWrite(
    auth,
    path,
    "deploy release",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    DEPLOY_TIMEOUT_MS,
  );
  return projectRelease((await readJson(res, "deploy release", binding(auth, opts.workspaceId))) as Record<string, unknown>);
}

/**
 * The bytes of a release, as the archive a deploy already knows how to import.
 *
 * Two steps, because the server does not stream the file itself: ask for a
 * signed link, then follow it. The link is a credential with an expiry — it
 * carries its own signature in the query string — so it is never logged, never
 * returned to a caller, and never sent the Authorization header, which would
 * both be redundant and hand a bearer token to a storage host.
 *
 * The archive is a gzipped tar carrying `workspace.json`, which is the same
 * shape `encodeWorkspaceArchive` produces. That is why a release can be stood
 * up on an environment through the ordinary import path rather than a second
 * pipeline of its own.
 */
export async function downloadRelease(
  auth: ResolvedAuth,
  opts: { workspaceId: number; id: number; base?: string },
): Promise<Uint8Array> {
  const path = `${base(opts.workspaceId)}/${opts.id}/export`;
  const res = await metaRead(auth, path, "export release", opts.base);
  const link = (await readJson(res, "export release", binding(auth, opts.workspaceId, opts.base))) as { src?: unknown };
  const src = typeof link.src === "string" && link.src !== "" ? link.src : undefined;
  if (src === undefined) {
    throw new Error(`export release: the instance returned no download link.`);
  }
  // Retried like every other read: a GET of stored bytes changes nothing. Not
  // through `fetchReadOrExplain`, because the failure has to be phrased WITHOUT
  // the URL — the message is user-facing and the link is signed — so the retry
  // loop is used bare and the explanation is built here with a stand-in.
  let file: Response;
  try {
    file = await retryingFetch(src, { method: "GET", signal: AbortSignal.timeout(DEPLOY_TIMEOUT_MS) });
  } catch (err) {
    throw explainFetchFailure(err, {
      url: src,
      what: "download release archive",
      timeoutMs: DEPLOY_TIMEOUT_MS,
      display: "the release download link",
    });
  }
  if (!file.ok) {
    // `status` rides on the error so a caller can tell a server error (5xx) from a refusal.
    throw Object.assign(
      new Error(`download release archive failed (${statusLabel(file)}). The link may have expired — retry.`),
      { status: file.status },
    );
  }
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Import a release archive into a workspace as a new release record. The write
 * a transfer lands on its destination.
 *
 * The bytes go up exactly as given: a transfer proves itself afterwards by
 * comparing content hashes, so nothing here may re-encode, trim or re-compress
 * them. The part is named `release.tar.gz` because an `.enc.gz` name makes the
 * server treat the archive as encrypted and demand a password for it.
 *
 * One attempt, on the long budget: the server stores the archive and writes the
 * record inside this request, so a client that gave up early — or tried again —
 * can leave a second copy behind. A 5xx or a dropped connection therefore says
 * nothing about whether the release now exists; the caller settles that by
 * reading the destination, not by importing again.
 */
export async function importRelease(
  auth: ResolvedAuth,
  opts: { workspaceId: number; archive: Uint8Array },
): Promise<{ id: number }> {
  const form = new FormData();
  form.append("file", new Blob([opts.archive as Uint8Array<ArrayBuffer>], { type: "application/gzip" }), "release.tar.gz");
  const res = await metaWrite(
    auth,
    `${base(opts.workspaceId)}/import`,
    "import release",
    { method: "POST", body: form },
    DEPLOY_TIMEOUT_MS,
  );
  const body = await readJson(res, "import release", binding(auth, opts.workspaceId));
  const id = body !== null && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
  if (typeof id !== "number") {
    throw new Error(`import release: the instance returned no release id.`);
  }
  return { id };
}

/**
 * Set a release's description. The route takes the name too, so the stored
 * name is sent back unchanged. Returns the record as the update answered it.
 */
export async function updateReleaseDescription(
  auth: ResolvedAuth,
  opts: { workspaceId: number; id: number; name: string; description: string },
): Promise<ReleaseSummary> {
  const res = await metaWrite(auth, `${base(opts.workspaceId)}/${opts.id}`, "update release", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: opts.name, description: opts.description }),
  });
  const body = await readJson(res, "update release", binding(auth, opts.workspaceId));
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`update release: the instance answered with no release record.`);
  }
  return projectRelease(body as Record<string, unknown>);
}

/**
 * The name the instance gives the scratch workspace it renders a release in:
 * `workspace-<uuid>`, fresh on every export.
 */
const SCRATCH_WORKSPACE_NAME = /"workspace-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/gi;

/**
 * A release as a XanoScript multidoc.
 *
 * `records` asks for the table rows the release carries; without it the
 * document holds schema and logic only, and a seeded release would lose its
 * rows with nothing to say so.
 *
 * With `name`, deterministic: the instance renders a release inside a scratch
 * workspace with a random name, and that name is written into the document —
 * so the same release exported twice differed on that one line. It is replaced
 * with the release's own name, which is what the document is a copy of.
 */
export async function exportRelease(
  auth: ResolvedAuth,
  opts: { workspaceId: number; id: number; records?: boolean; name?: string },
): Promise<string> {
  const path = `${base(opts.workspaceId)}/${opts.id}/multidoc${opts.records === true ? "?records=true" : ""}`;
  const res = await metaRead(auth, path, "export release");
  const text = await res.text();
  if (!res.ok) throw new ReleaseHttpError(res.status, "export release", res.statusText, text, binding(auth, opts.workspaceId));
  return opts.name === undefined ? text : text.replace(SCRATCH_WORKSPACE_NAME, JSON.stringify(opts.name));
}

/**
 * Delete a release. Reports an already-absent release as gone rather than as a
 * failure, so a repeated teardown is not an error.
 */
export async function deleteRelease(
  auth: ResolvedAuth,
  opts: { workspaceId: number; id: number; base?: string },
): Promise<{ alreadyGone: boolean }> {
  const path = `${base(opts.workspaceId)}/${opts.id}`;
  const res = await metaWrite(auth, path, "delete release", { method: "DELETE" }, TIMEOUT_MS, opts.base);
  if (res.status === 404) return { alreadyGone: true };
  if (!res.ok) {
    // A 5xx failed somewhere inside the delete, which may have run — a gateway's
    // 502 came back for a release that WAS deleted; a 4xx refused it.
    throw new ReleaseHttpError(
      res.status,
      "delete release",
      res.statusText,
      await res.text(),
      binding(auth, opts.workspaceId, opts.base),
      writeStatusAftermath(res.status),
    );
  }
  return { alreadyGone: false };
}
