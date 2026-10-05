/**
 * Node-only transport for the table object on the meta API: list.
 *
 * This module exists because a table's identifiers are otherwise unobtainable.
 * The release route's `table_ids` selects which tables' ROWS ride along in an
 * archive, and neither an id nor a guid appears in any artifact a user holds —
 * so the capability was unreachable until something could enumerate it.
 *
 * **Guids select; ids are printed for recognition.** Both are server-assigned
 * and neither is portable, but they fail differently. Ids are small dense
 * integers, so a stale one almost certainly EXISTS on the next backend and
 * resolves to a real but different table; a stale guid is simply absent from the
 * listing, so a membership check refuses it. Callers therefore select by guid
 * and resolve it to that host's id at the boundary — see `resolveSeedSelection`
 * in `src/emit/release-create.ts`.
 *
 * **A name is never a key.** The table-create route declares its name as `text`
 * with NO filter — no trim, no length bound, no pattern — so a table name may
 * contain a comma, an emoji, leading or trailing whitespace, or be the string
 * `12`. The engine's own documented example is `new table 123`. A name is also
 * the one identifier a user can CHANGE, so a saved name selection silently
 * re-targets after a rename. Nothing here may treat a name as a delimiter-safe
 * key; it is for display only.
 *
 * **Everything is projected.** A listed row carries its full schema and index
 * payload — the route has no field-selection parameter — and none of that helps
 * a caller picking tables. {@link TableSummary} is what leaves this module, and it
 * reduces the schema to the NAMES of columns a caller must be warned about
 * before carrying their rows anywhere.
 *
 * Follows the SDK's fetch conventions: `new URL(path, auth.instance)`, a bearer
 * header, and an `AbortSignal.timeout` bound.
 */
import type { BearerTarget, ResolvedAuth } from "../auth/token.js";
import {
  fetchOrExplain,
  readBodyText,
  safeHttpFailure,
  SENT_AFTERMATH,
  withWriteStatusAftermath,
  type BindingContext,
} from "../util/http.js";
import { hasString, listAnswer, notTheAnswer, writeTransportFailure } from "./answer-shape.js";
import { isNonPublicColumn } from "../workspace/seed-coerce.js";

/** Bound each call so a stalled endpoint cannot hang the CLI or CI. */
const TIMEOUT_MS = 30_000;

/** The projected, safe-to-print view of a table. Never the raw record. */
export interface TableSummary {
  /**
   * The table's id — what the wire carries, resolved per host.
   *
   * Under a TENANT base these are the tenant's ids, and a tenant's workspace is
   * always id 1, so an id read from one host names a DIFFERENT table on another.
   * A caller crossing that boundary must re-list, never reuse. Printed in
   * listings because other engine surfaces and URLs show it, so dropping it
   * would make correlating a table across tools harder — for recognition, not
   * for selection, which is {@link guid}'s job.
   */
  id: number;
  /**
   * The table's guid — what a caller SELECTS by.
   *
   * Printed in listings because it is what an author passes to choose this
   * table.
   *
   * Two spellings are in play and both must survive unaltered. The SDK derives
   * 32-char hex (`md5(dbo:<name>)`, pinned in `xano.lock`) and the engine
   * assigns ~27-char base64url containing `-` and `_`. Whichever a backend
   * STORED is the only one that matches there — and a backend this project
   * deployed now stores the SDK's spelling, because the deploy asks it to.
   *
   * **Stable through the release flow AND through a redeploy.** Measured: a
   * guid read off an ephemeral is byte-identical after `release create` and
   * after `promote` into a workspace branch, while ids move. The full-replace
   * import `xanosdk deploy` performs sends `preserve_guids`, so the bundle's
   * value is what gets stored and a guid written down earlier
   * keeps resolving. What still moves it is a RENAME, since the name is the
   * seed the derived guid comes from. Every surface that offers guid selection
   * has to say so.
   */
  guid: string;
  /**
   * The table's display name. Free text: may hold commas, emoji, or surrounding
   * whitespace, and is not safe to use as a key or a delimiter-separated token.
   */
  name: string;
  /**
   * Columns whose values should not be swept into an artifact unasked, by name.
   *
   * Decided by {@link isNonPublicColumn}, which owns the rule and the reason it
   * is not simply `access !== "public"` — shared with the static-host guard so
   * the two cannot drift into disagreeing about the same policy.
   */
  guardedColumns: string[];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * Project a raw table record to the safe summary.
 *
 * An allow-list rather than a delete-list: a server that starts returning a new
 * field should not start leaking it. A row missing any identifier is dropped —
 * one with no guid cannot be selected, one with no id cannot be sent, and one
 * with no name cannot be shown, so none is something a caller can act on. A
 * missing guid is dropped rather than projected as `undefined`, which would
 * reach the membership check as a token that matches nothing and refuse with a
 * message about a re-mint that did not happen.
 */
export function projectTable(raw: Record<string, unknown>): TableSummary[] {
  const id = asNumber(raw.id);
  const name = asString(raw.name);
  const guid = asString(raw.guid);
  if (id === undefined || name === undefined || guid === undefined) return [];
  // Column NAMES only. A column's value never passes through here, so a guard
  // built on this cannot itself become the leak it exists to prevent.
  return [{ id, name, guid, guardedColumns: guardedIn(raw.schema) }];
}

/**
 * The names of non-public columns in a schema, descending into nested fields.
 *
 * An `object` column carries its own sub-fields under `children`, and each of
 * those declares its own `access` and `sensitive` — so a top-level-only scan
 * reports a table as clean while a sensitive sub-field rides along inside it.
 * Nested names are reported by path (`profile.ssn`) so the warning names
 * something the reader can actually find.
 */
export function guardedIn(schema: unknown, prefix = ""): string[] {
  if (!Array.isArray(schema)) return [];
  return schema.flatMap((col): string[] => {
    if (col === null || typeof col !== "object") return [];
    const c = col as Record<string, unknown>;
    const colName = asString(c.name);
    if (colName === undefined) return [];
    const path = `${prefix}${colName}`;
    // A guarded parent covers everything inside it; naming the children too
    // would be noise, so recurse only into a parent that is not itself flagged.
    return isNonPublicColumn(c) ? [path] : guardedIn(c.children, `${path}.`);
  });
}

function base(workspaceId: number): string {
  return `/api:meta/workspace/${workspaceId}/table`;
}

/**
 * The page size to ask for. The route caps `per_page` at 10000 and defaults to
 * 50. Larger than the sibling list routes use, deliberately: the walk is
 * sequential, so every page is a round trip, and this list is on the path
 * of every `--seed` cut. At 1000 a realistic workspace is one request; the walk
 * below does not depend on the value.
 */
const PER_PAGE = 1000;

/**
 * A table row is one only when it carries all three identifiers — an id to
 * send, a guid to select by, a name to show. A page with a row that does not
 * is not a table list: refused whole, never read as "no tables" or as fewer.
 */
const isTableRow = (row: Record<string, unknown>): boolean =>
  typeof row.id === "number" && hasString(row, "name") && hasString(row, "guid");

/**
 * Every table in the workspace, as the server orders them.
 *
 * Walked to exhaustion rather than read one page deep, for the same reason the
 * release and tenant lists are: the route paginates, and a table missing from a
 * truncated first page reads as a table that does not exist — which would turn
 * a valid guid into a "no such table" refusal at the selection boundary.
 *
 * `base` addresses a TENANT's own meta API, where the workspace is always id 1.
 *
 * Takes only the bearer, so a Xano Engine's url and token list its tables
 * exactly as a hosted credential lists a workspace's — same walk, same
 * projection, same rows. `binding` is what a 403 is explained against; a
 * hosted caller passes it, and a Xano Engine has none, since its bearer is
 * its own and bound to no Xano workspace.
 */
export async function listTables(
  auth: BearerTarget,
  opts: { workspaceId: number; base?: string; binding?: BindingContext },
): Promise<TableSummary[]> {
  const out: TableSummary[] = [];
  for (let page = 1; ; page++) {
    const path = `${base(opts.workspaceId)}?page=${page}&per_page=${PER_PAGE}`;
    const res = await metaFetch(auth, path, "list tables", { method: "GET" }, opts.base);
    const text = await readText(res, "list tables", opts.binding);
    const { rows } = listAnswer(text, "list tables", routeUrl(auth, path, opts.base).href, isTableRow, { safe: true });
    for (const r of rows) out.push(...projectTable(r));
    // A short page is the last one. An empty first page means none exist.
    if (rows.length < PER_PAGE) return out;
  }
}

/**
 * Whether any row of one table satisfies `match`, walking its content pages in
 * id order and stopping at the first that does.
 *
 * Reads rows, so it is only for a question the schema cannot answer — whether a
 * file column actually holds a file in the rows a release would carry. A cut
 * that carries those rows reads every one of them anyway, so the walk costs no
 * more than the cut it guards. `base` addresses a tenant's own meta API, as
 * {@link listTables} does.
 */
export async function someTableRow(
  auth: BearerTarget,
  opts: { workspaceId: number; tableId: number; base?: string; binding?: BindingContext },
  match: (row: Record<string, unknown>) => boolean,
): Promise<boolean> {
  for (let page = 1; ; page++) {
    const path = `${base(opts.workspaceId)}/${opts.tableId}/content?page=${page}&per_page=${PER_PAGE}`;
    const res = await metaFetch(auth, path, "read table rows", { method: "GET" }, opts.base);
    const text = await readText(res, "read table rows", opts.binding);
    const { rows } = listAnswer(text, "read table rows", routeUrl(auth, path, opts.base).href, () => true, { safe: true });
    if (rows.some(match)) return true;
    if (rows.length < PER_PAGE) return false;
  }
}

/**
 * The ids of every row one table holds, walking its content pages. Reads rows
 * — for a question only the rows answer: which of a merge's seed rows land on
 * an id the table already holds. `base` addresses a tenant's own meta API, as
 * {@link listTables} does.
 */
export async function tableRowIds(
  auth: BearerTarget,
  opts: { workspaceId: number; tableId: number; base?: string; binding?: BindingContext },
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let page = 1; ; page++) {
    const path = `${base(opts.workspaceId)}/${opts.tableId}/content?page=${page}&per_page=${PER_PAGE}`;
    const res = await metaFetch(auth, path, "read table rows", { method: "GET" }, opts.base);
    const text = await readText(res, "read table rows", opts.binding);
    const { rows } = listAnswer(text, "read table rows", routeUrl(auth, path, opts.base).href, () => true, { safe: true });
    for (const row of rows) if (row.id !== undefined && row.id !== null) ids.add(String(row.id));
    if (rows.length < PER_PAGE) return ids;
  }
}

/**
 * How many rows one table holds right now, read off the content route's
 * `itemsTotal` with a one-row page. `undefined` when the answer carries no
 * total — the caller says the count is unknown rather than inventing one.
 * One read whatever the table's size; `base` addresses a tenant's own meta
 * API, as {@link listTables} does.
 */
export async function countTableRows(
  auth: BearerTarget,
  opts: { workspaceId: number; tableId: number; base?: string; binding?: BindingContext },
): Promise<number | undefined> {
  const path = `${base(opts.workspaceId)}/${opts.tableId}/content?page=1&per_page=1`;
  const res = await metaFetch(auth, path, "count table rows", { method: "GET" }, opts.base);
  const text = await readText(res, "count table rows", opts.binding);
  const { envelope } = listAnswer(text, "count table rows", routeUrl(auth, path, opts.base).href, () => true, { safe: true });
  const total = envelope?.itemsTotal;
  return typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : undefined;
}

/**
 * A row counter over one workspace's tables: lists them once, finds a table by
 * guid (else by name) and counts its rows. `undefined` when the table is not
 * there or its rows could not be counted — the caller says so rather than
 * guessing.
 */
export function tableRowCounter(
  auth: BearerTarget,
  opts: { workspaceId: number; base?: string },
): (table: { name: string; guid?: string }) => Promise<number | undefined> {
  let listed: Promise<TableSummary[] | undefined> | undefined;
  return async ({ name, guid }) => {
    listed ??= listTables(auth, opts).catch(() => undefined);
    const tables = await listed;
    const here = (guid === undefined ? undefined : tables?.find((t) => t.guid === guid)) ?? tables?.find((t) => t.name === name);
    if (here === undefined) return undefined;
    return countTableRows(auth, { ...opts, tableId: here.id }).catch(() => undefined);
  };
}

/**
 * Empty ONE table, restarting its primary-key sequence.
 *
 * Per-table on purpose. The import route has a `truncate` of its own, but it
 * empties every table the import touched and the archive carries every table's
 * schema — so there is no way to aim it at a named table, and reaching for it
 * to clear one would clear the workspace's audit history alongside.
 *
 * `reset` restarts the key sequence, which is what makes a re-seed land the ids
 * the seed declares rather than continuing past whatever was deleted. Seed rows
 * with an omitted `id` are numbered `1..N` at compile time (see
 * `assignPrimaryKeys`), so without the reset the second run of a reset would
 * produce rows whose ids no longer match the ones the project believes it wrote.
 */
export async function truncateTable(
  auth: ResolvedAuth,
  opts: { workspaceId: number; tableId: number; base?: string },
): Promise<void> {
  const path = `${base(opts.workspaceId)}/${opts.tableId}/truncate?reset=true`;
  const res = await metaFetch(auth, path, "truncate table", { method: "DELETE" }, opts.base);
  const text = await readBodyText(res, "truncate table", { aftermath: SENT_AFTERMATH });
  if (!res.ok) {
    const head = safeHttpFailure("truncate table", res, text, binding(auth, opts.workspaceId, opts.base));
    throw new Error(withWriteStatusAftermath(head, res.status));
  }
  writeAcknowledged(text, "truncate table", routeUrl(auth, path, opts.base).href);
}

/**
 * A write's 2xx is an API's answer only when it is JSON (or nothing): a proxy's
 * page or a login wall answering 200 did nothing we can know of, so it is
 * refused as a write whose outcome is unknown.
 */
function writeAcknowledged(text: string, action: string, url: string): void {
  if (text.trim() === "") return;
  try {
    JSON.parse(text);
  } catch {
    throw notTheAnswer(action, text, url, { safe: true, write: true });
  }
}

/**
 * Insert rows into one table in a single call.
 *
 * Paired with {@link truncateTable} and deliberately NOT wrapped in anything
 * that pretends the pair is atomic — it is two calls, and a failure between
 * them leaves the table empty. That is survivable for exactly the data this is
 * for: reference rows the project can re-derive from source, where running it
 * again is a complete remedy. The caller says so in its output rather than
 * engineering around a transaction the API does not offer.
 *
 * The rows are sent in the SAME coerced shape the deploy path builds, so a
 * value that would be rejected here is rejected identically on a deploy.
 */
export async function insertTableRows(
  auth: ResolvedAuth,
  opts: {
    workspaceId: number;
    tableId: number;
    rows: readonly Record<string, unknown>[];
    base?: string;
  },
): Promise<void> {
  if (opts.rows.length === 0) return;
  const path = `${base(opts.workspaceId)}/${opts.tableId}/content/bulk`;
  const res = await metaFetch(
    auth,
    path,
    "insert table rows",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: opts.rows }),
    },
    opts.base,
  );
  if (!res.ok) {
    // The body is DISCARDED, not merely left un-appended. `safeHttpFailure`
    // already refuses to print a raw body, but it does surface the response's
    // labelled `message` — and on this route that message is where a rejected
    // row's own value appears. A seed value may be one the schema marks
    // non-public, so the one route that echoes rejected values back is the one
    // route whose message cannot be rendered. The caller names the table, which
    // is the part an operator can act on.
    await readBodyText(res, "insert table rows", { aftermath: SENT_AFTERMATH });
    const head = safeHttpFailure("insert table rows", res, "", binding(auth, opts.workspaceId, opts.base));
    throw new Error(withWriteStatusAftermath(head, res.status));
  }
  writeAcknowledged(await readBodyText(res, "insert table rows", { aftermath: SENT_AFTERMATH }), "insert table rows", routeUrl(auth, path, opts.base).href);
}

/** A route under `base` (appended, never resolved — see {@link metaFetch}) or under the credential's instance. */
function routeUrl(auth: BearerTarget, path: string, base?: string): URL {
  return base !== undefined ? new URL(`${base.replace(/\/$/, "")}${path}`) : new URL(path, auth.instance);
}

async function metaFetch(
  auth: BearerTarget,
  path: string,
  action: string,
  init?: RequestInit,
  base?: string,
): Promise<Response> {
  // CONCATENATED, never resolved: a tenant without a dedicated domain is served
  // under a `/tenant/<name>` prefix on the instance origin, and
  // `new URL(path, base)` drops that prefix — sending the call to the parent
  // instance and listing the WRONG workspace's tables, whose ids would then be
  // silently ignored by a cut against the tenant.
  const url = routeUrl(auth, path, base);
  return fetchOrExplain(
    url.href,
    {
      ...init,
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${auth.access_token}`,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
    action,
    TIMEOUT_MS,
  ).catch((err: unknown) => {
    // A write that got no answer may have been received: said so, unless the
    // connection was refused before anything was sent.
    throw (init?.method ?? "GET").toUpperCase() !== "GET" ? writeTransportFailure(err) : err;
  });
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

/** A read's 2xx body, or the status failure. Host and a summary, never the body — see `notJsonError`. */
async function readText(res: Response, action: string, bind?: BindingContext): Promise<string> {
  const text = await readBodyText(res, action);
  // `status` rides on the error so a caller can tell a server error (5xx) — no answer — from a refusal.
  if (!res.ok) throw Object.assign(new Error(safeHttpFailure(action, res, text, bind)), { status: res.status });
  return text;
}
