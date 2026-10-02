/**
 * Node-only transport for ephemeral-tenant lifecycle on the parent meta-API:
 * create / get / list / delete, plus a readiness poll. Everything is projected
 * to a small, secret-free {@link EphemeralSummary} — the raw tenant blob carries
 * cluster/k8s/license internals that must never land in shell history or CI logs.
 *
 * Two workspace ids are in play and must not be confused: the PARENT workspace id
 * (resolved from the caller's token) scopes these routes and is where an
 * ephemeral is *created*; the env's own internal workspace id is always `1` and
 * is only used later, by the import transport, against the env's base URL.
 *
 * Follows the SDK's fetch conventions: `new URL(path, auth.instance)`, a bearer
 * header, an `AbortSignal.timeout` bound, and the shared `util/http` failure
 * wording on non-2xx (`"<action> failed (<status> <statusText>): <server
 * sentence>"`, one line, with the raw body under `XANOSDK_DEBUG`).
 */
import type { ResolvedAuth } from "../auth/token.js";
import { withArticle } from "../util/article.js";
import { shellQuote } from "../util/shell-quote.js";
import { contextFlags } from "../emit/context-flags.js";
import { fetchOrExplain, httpFailure, readBodyText, TransportError, withWriteStatusAftermath } from "../util/http.js";
import { deleteAnswer, hasString, listAnswer, recordAnswer, writeTransportFailure } from "./answer-shape.js";

/** Bound each metadata call so a stalled endpoint can't hang the CLI/CI. */
const TIMEOUT_MS = 30_000;
/** Readiness poll defaults: a freshly created ephemeral may be provisioning. */
const READY_TIMEOUT_MS = 120_000;
const READY_INTERVAL_MS = 2_000;

/** The projected, safe-to-print view of an ephemeral tenant. Never the raw blob. */
export interface EphemeralSummary {
  id: number | undefined;
  /** Server-assigned tenant name — the stable handle. */
  name: string;
  display: string | undefined;
  /** Public base URL (`https://{xano_domain}`), or undefined if the row omits a domain. */
  url: string | undefined;
  state: string | undefined;
  /** `ephemeral_expires_at` as the API serializes it (date string or epoch number). */
  expiresAt: string | number | undefined;
  /** Parent workspace id, when the row carries one (global list). */
  workspaceId: number | undefined;
  /**
   * `ephemeral`, `sandbox`, `standard` or `run` — what KIND of deployment this
   * is, which decides what may be done with it. Undefined when the row omits
   * it, and callers gating on this must fail closed rather than treat that as
   * permission.
   */
  type: string | undefined;
  /** The id of the release last landed on it, when the row names one. */
  deployedReleaseId?: number;
}

/**
 * How a human line names an ephemeral: `ephemeral "e4f2-…" ("My App")`, the
 * display name beside the handle when it differs.
 */
export function namedEphemeral(summary: Pick<EphemeralSummary, "name" | "display">): string {
  const shown =
    summary.display !== undefined && summary.display !== "" && summary.display !== summary.name
      ? ` (${JSON.stringify(summary.display)})`
      : "";
  return `ephemeral ${JSON.stringify(summary.name)}${shown}`;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * Derive a tenant's public base URL, mirroring the backend: prefer its own
 * `xano_domain` (`https://`, or `http://` for `localhost:*`), else the instance
 * origin with a `/tenant/{name}` prefix. Never throws.
 */
export function tenantBaseUrl(tenant: Record<string, unknown>, instance: string): string {
  const host = asString(tenant.xano_domain);
  if (host !== undefined) {
    const scheme = host.startsWith("localhost:") ? "http" : "https";
    return `${scheme}://${host}`;
  }
  const name = asString(tenant.name);
  if (name !== undefined) return new URL(`/tenant/${name}`, instance).href.replace(/\/$/, "");
  return instance.replace(/\/$/, "");
}

/** Parse an `ephemeral_expires_at` (date string or epoch seconds) to epoch ms, or NaN. */
export function expiresAtMs(expiresAt: string | number | undefined): number {
  if (expiresAt === undefined || expiresAt === null) return NaN;
  return typeof expiresAt === "number" ? expiresAt * 1000 : Date.parse(String(expiresAt).replace(" ", "T"));
}

/**
 * An expiry as ISO 8601 UTC (`…Z`), the one form every `--json` date takes;
 * a value that does not parse passes through as it came.
 */
function isoExpiry(v: unknown): string | number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? new Date(v * 1000).toISOString() : v;
  if (typeof v !== "string" || v === "") return undefined;
  const ms = expiresAtMs(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : v;
}

/** True when the tenant's expiry is known and already in the past. */
export function isExpired(expiresAt: string | number | undefined): boolean {
  const ms = expiresAtMs(expiresAt);
  return Number.isFinite(ms) && ms <= Date.now();
}

/**
 * Project a raw tenant record to the safe summary, deriving its base URL. The URL
 * always resolves: the tenant's own `xano_domain` when it has one, else the
 * instance-origin tenant path (`{instance}/tenant/{name}`) — the form dev/self-
 * hosted instances use when a tenant has no dedicated domain. `url` is undefined
 * only when the row carries no name to route to.
 */
export function projectTenant(
  tenant: Record<string, unknown>,
  instance: string,
): EphemeralSummary {
  const name = asString(tenant.name);
  return {
    id: asNumber(tenant.id),
    name: name ?? "",
    display: asString(tenant.display),
    url: name !== undefined || asString(tenant.xano_domain) ? tenantBaseUrl(tenant, instance) : undefined,
    state: asString(tenant.state),
    expiresAt: isoExpiry(tenant.ephemeral_expires_at),
    workspaceId: asNumber(tenant.workspace_id),
    type: asString(tenant.type),
    // `{ id: 0 }` is the row's empty relation: nothing landed.
    ...releaseIdOf(tenant.release),
  };
}

/**
 * Every call in this module goes through here, so the transport wrapper does
 * too: a connection dropped mid-run names the URL it was reaching for and the
 * reason it died, rather than surfacing as a bare `TypeError: fetch failed`.
 * `action` is the caller's own verb, so the line reads as the step that failed.
 */
async function metaFetch(
  auth: ResolvedAuth,
  path: string,
  action: string,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(path, auth.instance);
  const write = (init?.method ?? "GET").toUpperCase() !== "GET";
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
    throw write ? writeTransportFailure(err) : err;
  });
}

/**
 * A 2xx's body, or the failure: a non-2xx through the shared one-line wording,
 * never this route's path. A write's 5xx adds that it may or may not have taken
 * effect — the instance failed somewhere inside it; a 4xx is a refusal.
 */
async function readText(res: Response, action: string, url: string, opts: { write?: boolean } = {}): Promise<string> {
  const text = await readBodyText(res, action, { url });
  if (!res.ok) {
    const head = httpFailure(action, res, text);
    const err = new Error(opts.write === true ? withWriteStatusAftermath(head, res.status) : head);
    // Read by a lookup: a 5xx is a backend that could not be resolved (exit 8).
    Object.defineProperty(err, "status", { value: res.status, enumerable: false });
    throw err;
  }
  return text;
}

/**
 * A tenant row, or the shared not-an-API-response refusal.
 *
 * A 2xx is only a tenant when it carries a tenant's name: every caller acts on
 * the name (it is the handle), and a stranger's JSON projected as-is became
 * `{"name": ""}` and a zero exit. A write says what the unreadable answer means
 * for it; a read changed nothing.
 */
async function readTenant(
  res: Response,
  action: string,
  path: string,
  instance: string,
  opts: { write?: boolean } = {},
): Promise<Record<string, unknown>> {
  const url = new URL(path, instance).href;
  return recordAnswer(await readText(res, action, url, opts), action, url, (row) => hasString(row, "name"), opts);
}

/**
 * True when a create-ephemeral failure is the instance saying the FEATURE is
 * off, rather than anything about this request.
 *
 * Matched on the engine's message rather than the status, deliberately: the
 * response is a plain 500 (`ERROR_FATAL`) that is indistinguishable from any
 * other server-side failure, so the message is the only signal there is. A
 * substring keeps it working if the surrounding envelope changes; if the
 * message itself ever changes, this stops matching and the caller falls back to
 * the raw error it printed before — a lost hint, not a wrong one.
 */
export function isEphemeralDisabled(err: unknown): boolean {
  return err instanceof Error && /ephemeral tenants are not enabled/i.test(err.message);
}

/** Create a new ephemeral tenant in the parent workspace. */
export async function createEphemeral(
  auth: ResolvedAuth,
  opts: { parentWorkspaceId: number; display: string; description?: string; expiresHours?: number },
): Promise<EphemeralSummary> {
  const path = `/api:meta/workspace/${opts.parentWorkspaceId}/ephemeral`;
  const body: Record<string, unknown> = { display: opts.display, tag: [] };
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.expiresHours !== undefined) body.expires_hours = opts.expiresHours;
  const res = await metaFetch(auth, path, "create ephemeral", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const tenant = await readTenant(res, "create ephemeral", path, auth.instance, { write: true });
  return projectTenant(tenant, auth.instance);
}

/**
 * A name that resolved to a tenant which is NOT an ephemeral. The tenant route
 * answers for every tenant in the workspace, so without this gate `ephemeral
 * delete <standard-tenant>` deleted a real tenant and reported it as a
 * throwaway. Exit 8 — the named ephemeral is not there — and the hint names
 * the `tenant` verbs that do address it.
 */
export class NotAnEphemeralError extends Error {
  override readonly name = "NotAnEphemeralError";
  readonly exitCode = 8;
  constructor(
    readonly tenant: string,
    readonly type: string | undefined,
    /** What people call it, named beside the handle as every backend line names one. */
    readonly display?: string,
  ) {
    const named = `tenant ${JSON.stringify(tenant)}${
      display !== undefined && display !== "" && display !== tenant ? ` (${JSON.stringify(display)})` : ""
    }`;
    super(
      (type === undefined
        ? `No ephemeral named "${tenant}": ${named} exists but reports no type, so it is not treated as one.`
        : `No ephemeral named "${tenant}": ${named} is ${withArticle(type)} tenant, not an ephemeral.`) +
        // With this run's credential flags, which a bare `tenant` command would not read.
        ` Nothing was changed. \`xanosdk tenant get ${shellQuote(tenant)}${contextFlags()}\` shows it, and \`tenant:${tenant}\` selects it` +
        ` (\`xanosdk tenant delete ${shellQuote(tenant)}${contextFlags()}\` is how a tenant is deleted).`,
    );
  }
}

/**
 * Get an ephemeral tenant by name. Returns `null` on 404 (swept/deleted) so callers can create.
 *
 * Throws {@link NotAnEphemeralError} when the name is a tenant of another type:
 * every caller acts on the answer as an ephemeral. A row reporting no type is
 * returned for a read; the WRITES below ({@link deleteEphemeral},
 * {@link renameEphemeral}) require the type outright, since a delete acting on
 * a standard tenant is unrecoverable.
 */
export async function getEphemeral(
  auth: ResolvedAuth,
  opts: { parentWorkspaceId: number; name: string },
): Promise<EphemeralSummary | null> {
  const path = `/api:meta/workspace/${opts.parentWorkspaceId}/tenant/${encodeURIComponent(opts.name)}`;
  const res = await metaFetch(auth, path, "get ephemeral", { method: "GET" });
  if (res.status === 404) {
    await res.text().catch(() => "");
    return null;
  }
  const tenant = await readTenant(res, "get ephemeral", path, auth.instance);
  const summary = projectTenant(tenant, auth.instance);
  if (summary.type !== undefined && summary.type !== "ephemeral") throw new NotAnEphemeralError(opts.name, summary.type, summary.display);
  return summary;
}

/**
 * Change an existing ephemeral's display name.
 *
 * There is no rename route, only the general tenant update, and it REPLACES
 * every field it takes — an omitted `domain` or `proxy` is a missing param, and
 * one sent as anything but its current value overwrites it. So the tenant is
 * read first and each field is sent back as it was, with only `display`
 * changed. Measured live on an ephemeral: display changes, and the expiry, the
 * type and every other field are kept. The expiry is NOT among the fields this
 * route writes, which is why `--expires-hours` cannot follow a rename here.
 */
export async function renameEphemeral(
  auth: ResolvedAuth,
  opts: { parentWorkspaceId: number; name: string; display: string },
): Promise<void> {
  const path = `/api:meta/workspace/${opts.parentWorkspaceId}/tenant/${encodeURIComponent(opts.name)}`;
  const current = await readTenant(
    await metaFetch(auth, path, "read ephemeral", { method: "GET" }),
    "read ephemeral",
    path,
    auth.instance,
  );
  const type = asString(current.type);
  if (type !== "ephemeral") throw new NotAnEphemeralError(opts.name, type, asString(current.display));
  const rbac = current.rbac as { enabled?: unknown } | undefined;
  const body = {
    display: opts.display,
    description: typeof current.description === "string" ? current.description : "",
    domain: current.domain ?? null,
    proxy: current.proxy ?? null,
    tag: Array.isArray(current.tag) ? current.tag : [],
    rbac: { enabled: rbac?.enabled === true },
    tasks: current.tasks === true,
    ingress: current.ingress === true,
  };
  const res = await metaFetch(auth, path, "rename ephemeral", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Only its SHAPE is checked — an object, not a page, `null` or a list — since
  // nothing is read from it: the caller keeps the record it already had rather
  // than trusting how much of the tenant the update echoes back.
  const url = new URL(path, auth.instance).href;
  recordAnswer(await readText(res, "rename ephemeral", url, { write: true }), "rename ephemeral", url, () => true, { write: true });
}

function releaseIdOf(release: unknown): { deployedReleaseId?: number } {
  const id = release !== null && typeof release === "object" ? (release as { id?: unknown }).id : undefined;
  return typeof id === "number" && id > 0 ? { deployedReleaseId: id } : {};
}

/** List ephemeral tenants in a workspace. Tolerates both a bare array and a `{ items }` envelope. */
export async function listEphemeral(
  auth: ResolvedAuth,
  opts: { parentWorkspaceId: number },
): Promise<EphemeralSummary[]> {
  const path = `/api:meta/workspace/${opts.parentWorkspaceId}/ephemeral`;
  return (await readRows(auth, path)).map((t) => projectTenant(t, auth.instance));
}

/** List ephemeral tenants across every workspace the caller can access. */
export async function listAllEphemeral(auth: ResolvedAuth): Promise<EphemeralSummary[]> {
  const path = `/api:meta/ephemeral`;
  return (await readRows(auth, path)).map((t) => projectTenant(t, auth.instance));
}

/**
 * The list, as a bare array or an `{ items }` envelope. Anything else is the
 * shared not-an-API-response refusal, never an empty list: "no ephemerals" read
 * off a stranger's body is a wrong answer, not a cautious one.
 */
async function readRows(auth: ResolvedAuth, path: string): Promise<Record<string, unknown>[]> {
  const res = await metaFetch(auth, path, "list ephemerals", { method: "GET" });
  const url = new URL(path, auth.instance).href;
  // Every row a tenant: a page of junk is refused, never read as "none".
  return listAnswer(await readText(res, "list ephemerals", url), "list ephemerals", url, (row) => hasString(row, "name")).rows;
}

/**
 * Delete an ephemeral tenant. A 404 is treated as already-gone (idempotent), not an error.
 *
 * The delete route removes ANY tenant, so the type is read first and anything
 * but an ephemeral is refused with {@link NotAnEphemeralError} before the
 * DELETE is sent — no caller can reach a standard tenant through this function.
 *
 * `verified` skips that read for a caller already holding the proof: it made
 * the tenant through {@link createEphemeral} (whose route makes only
 * ephemerals), or has just read it with `type: "ephemeral"`. Anything short of
 * that is read here.
 */
export async function deleteEphemeral(
  auth: ResolvedAuth,
  opts: { parentWorkspaceId: number; name: string; verified?: boolean },
): Promise<{ alreadyGone: boolean }> {
  if (opts.verified !== true) {
    const found = await getEphemeral(auth, opts);
    if (found === null) return { alreadyGone: true };
    // Fail closed: a row that does not SAY it is an ephemeral is not deleted as one.
    if (found.type !== "ephemeral") throw new NotAnEphemeralError(opts.name, found.type, found.display);
  }
  const path = `/api:meta/workspace/${opts.parentWorkspaceId}/tenant/${encodeURIComponent(opts.name)}`;
  const res = await metaFetch(auth, path, "delete ephemeral", { method: "DELETE" });
  if (res.status === 404) {
    await res.text().catch(() => "");
    return { alreadyGone: true };
  }
  const url = new URL(path, auth.instance).href;
  // A 2xx is a delete only when it carries the route's success answer (`null`):
  // a page, `{}`, `[]` or an empty body deleted nothing we can know of, and is
  // refused as a write whose outcome is unknown — the caller keeps its record.
  deleteAnswer(await readText(res, "delete ephemeral", url, { write: true }), "delete ephemeral", url);
  return { alreadyGone: false };
}

/** The one-time impersonation token — feeds the `?_ti=` dashboard URL, nothing else. */
export interface ImpersonateToken {
  _ti: string;
}

/**
 * Mint a one-time impersonation token for an ephemeral tenant. Unlike the other
 * transports this deliberately returns the raw token (not the secret-free
 * summary): it's the whole point of the call and is surfaced in the dashboard
 * URL. `guest` requests a read-only session (`?guest_read_only=true`).
 */
export async function impersonateEphemeral(
  auth: ResolvedAuth,
  opts: { parentWorkspaceId: number; name: string; guest?: boolean },
): Promise<ImpersonateToken> {
  const query = opts.guest ? "?guest_read_only=true" : "";
  const path = `/api:meta/workspace/${opts.parentWorkspaceId}/tenant/${encodeURIComponent(opts.name)}/impersonate${query}`;
  const url = new URL(path, auth.instance).href;
  const action = "open a dashboard session";
  const res = await metaFetch(auth, path, action, { method: "GET" });
  // Only an answer carrying the session token is one: `null`, a page or a
  // stranger's object is refused the shared way, which never names the field.
  const data = recordAnswer(await readText(res, action, url), action, url, (row) => hasString(row, "_ti"));
  return { _ti: data._ti as string };
}

/**
 * Poll until the ephemeral reports `state === "ok"` (importable), bounded by
 * `timeoutMs`. A freshly created tenant may still be provisioning; importing
 * before it is ready fails. Throws a clear error if it never becomes ready.
 */
export async function waitUntilReady(
  auth: ResolvedAuth,
  opts: { parentWorkspaceId: number; name: string },
  cfg: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<EphemeralSummary> {
  const timeoutMs = cfg.timeoutMs ?? READY_TIMEOUT_MS;
  const intervalMs = cfg.intervalMs ?? READY_INTERVAL_MS;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  let last: EphemeralSummary | null = null;
  let stateless = 0;
  for (;;) {
    try {
      last = await getEphemeral(auth, opts);
    } catch (err) {
      // A server error (5xx) — a gateway's blip in front of a tenant still
      // provisioning — or a rate limit (429) says nothing about readiness: polled again within the
      // budget (E2E pass 29: the first 503 gave up on a tenant just created).
      // Past the deadline it is thrown, for the caller to say as unanswered.
      // A connection that failed ends the wait at once, as it always has.
      if (!isServerErrorPoll(err) || Date.now() >= deadline) throw err;
      await sleep(intervalMs);
      continue;
    }
    if (last && last.state === "ok") return last;
    // An answer with no `state` at all is not "provisioning": polling it for
    // the whole timeout waits on a field that is not coming. A few in a row are
    // tolerated (a row read mid-write), then it is said at once.
    stateless = last !== null && last.state === undefined ? stateless + 1 : 0;
    if (stateless >= STATELESS_ANSWERS_TOLERATED) {
      throw new Error(
        `Ephemeral "${opts.name}" answered ${stateless} times with no \`state\`, so whether it is ready ` +
          `cannot be read — stopped waiting rather than polling for ${Math.round(timeoutMs / 1000)}s.`,
      );
    }
    if (Date.now() >= deadline) {
      // "gone" only for a tenant that answered 404: one that answered without
      // a state read "last state: gone" for a tenant that was plainly there.
      const lastSaid =
        last === null
          ? "the last answer was not found — the ephemeral is gone"
          : last.state === undefined
            ? "the last answer carried no state"
            : `last state: ${last.state}`;
      throw new Error(
        `Ephemeral "${opts.name}" did not become ready within ${Math.round(timeoutMs / 1000)}s (${lastSaid}).`,
      );
    }
    await sleep(intervalMs);
  }
}

/**
 * A poll that got no answer about the tenant: a server error (5xx), or a
 * transport failure. Exported for the deploy, which says one that outlasted
 * the wait as exit 8.
 */
export function isUnansweredPoll(err: unknown): boolean {
  return err instanceof TransportError || isServerErrorPoll(err);
}

/** A server error (5xx), or the instance's rate limit (429): neither says anything about the tenant. */
function isServerErrorPoll(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && ((status >= 500 && status < 600) || status === 429);
}

/** Consecutive answers with no `state` a readiness wait accepts before it stops. */
const STATELESS_ANSWERS_TOLERATED = 3;
