/**
 * Node-only transport for tenants on the meta API: list, get, deploy a release
 * onto one, delete, and open an impersonation session.
 *
 * A tenant and an ephemeral are the same primitive on the server — an ephemeral
 * is a tenant carrying an expiry — which is why this module reuses
 * `ephemeral.ts`'s projection and its base-URL derivation rather than restating
 * them. What differs is the audience: an ephemeral is a development
 * environment, a tenant is somebody's deployment, so the commands above these
 * two modules stay separate even where the wire does not.
 *
 * The reuse is deliberate on one point in particular. A tenant without a
 * dedicated domain is served under a `/tenant/<name>` path prefix, and that
 * prefix is APPENDED to, never resolved against — `new URL("/api:meta/…", base)`
 * silently discards it and addresses the parent instead. Deriving the base in
 * one place is what keeps a second copy of that bug from existing.
 *
 * Failures go through {@link safeHttpFailure}: these routes reach real
 * deployments, so an unlabelled error body never reaches a caller.
 *
 * Reads retry and writes do not. `list` and `get` go through {@link metaRead},
 * which retries a dropped connection — `get` is what settles an interrupted
 * `tenant deploy`, so it has to survive the blip that interrupted it. The deploy
 * and the delete go through {@link metaWrite} and get exactly one attempt.
 */
import type { ResolvedAuth } from "../auth/token.js";
import { asTimestamp } from "../util/timestamp.js";
import {
  fetchOrExplain,
  fetchReadOrExplain,
  readBodyText,
  safeHttpFailure,
  type BindingContext,
  SENT_AFTERMATH,
  writeStatusAftermath,
} from "../util/http.js";
import { deleteAnswer, hasString, isRecord, listAnswer, recordAnswer, writeTransportFailure } from "./answer-shape.js";
import {
  impersonateEphemeral,
  type EphemeralSummary,
  type ImpersonateToken,
  projectTenant,
} from "./ephemeral.js";

const TIMEOUT_MS = 30_000;
/** Landing a release onto a tenant rebuilds it; minutes, not seconds. */
const DEPLOY_TIMEOUT_MS = 600_000;

/**
 * A tenant route that answered, and answered with a failure.
 *
 * Typed so a caller can read the STATUS without parsing a sentence: a 4xx on a
 * deploy means the server refused it and the tenant is as it was, a 5xx means
 * the rebuild may have run in part or in full before failing.
 *
 * The message is {@link safeHttpFailure}'s, unchanged, and the body is not kept:
 * a tenant is somebody's deployment, and its unlabelled error body stays
 * unprinted wherever this error ends up.
 */
export class TenantHttpError extends Error {
  constructor(
    readonly status: number,
    action: string,
    statusText: string,
    body: string,
    bind?: BindingContext,
    /** A line appended under the status, for a refusal whose fix the CLI knows. */
    remedy?: string,
  ) {
    const head = safeHttpFailure(action, { status, statusText }, body, bind);
    super(remedy === undefined ? head : `${head}\n${remedy}`);
    this.name = "TenantHttpError";
  }
}

/**
 * The projected view of a tenant.
 *
 * An {@link EphemeralSummary} — it is the same record — plus the two fields
 * that say what the last `tenant deploy` left behind. An ephemeral is created
 * and destroyed rather than deployed onto, so those stay off its summary.
 */
export interface TenantSummary extends EphemeralSummary {
  /**
   * When a release last landed on this tenant, as ISO 8601 UTC. `undefined`
   * when the record carries none.
   *
   * Normalized the way a release's `createdAt` is, so the two can be compared
   * as strings: the route answers `2026-09-10 22:08:11+0000`, which is not ISO.
   * An unparseable value is passed through rather than dropped.
   */
  deployedAt?: string | undefined;
  /**
   * The id of the release last landed on this tenant, or `undefined` when none
   * has been.
   *
   * An ID, not a name, because the id is all both routes carry: get answers
   * `release: { id }`, and the list's `release.name` was recorded as `null`
   * for a release since deleted. The id outlives the release it names, so a
   * caller resolving it with `getRelease` must be ready for "gone". `{ id: 0 }`
   * — how these records spell an empty relation — reads as none.
   *
   * Both fields are optional in the type so a hand-built summary need not
   * invent them; {@link projectTenantRecord} always sets both keys.
   */
  deployedReleaseId?: number | undefined;
}


/** The id of a `{ id }` relation, with `0` — an empty relation — as none. */
function relationId(v: unknown): number | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const id = (v as { id?: unknown }).id;
  return typeof id === "number" && id > 0 ? id : undefined;
}

/**
 * Project a raw tenant record to the safe summary.
 *
 * An allow-list, like every projection here: the record carries the tenant's
 * license tier, its runtime and cluster wiring and its access settings, and
 * none of that is a caller's to print. Checked against a recorded response in
 * `test/fixtures/tenant/live-records.json`, not against what this expects.
 */
export function projectTenantRecord(raw: Record<string, unknown>, instance: string): TenantSummary {
  return {
    ...projectTenant(raw, instance),
    deployedAt: asTimestamp(raw.deployed_at),
    deployedReleaseId: relationId(raw.release),
  };
}

/** The URL and init every tenant call shares. */
function metaRequest(auth: ResolvedAuth, path: string, init: RequestInit, timeoutMs: number): { url: string; init: RequestInit } {
  return {
    url: new URL(path, auth.instance).href,
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
): Promise<Response> {
  const req = metaRequest(auth, path, init, timeoutMs);
  // A write that got no answer may have been received: said so, unless the
  // connection was refused before anything was sent.
  return fetchOrExplain(req.url, req.init, action, timeoutMs).catch((err: unknown) => {
    throw writeTransportFailure(err);
  });
}

/** A READ: a GET, retried on a dropped connection. Takes no `init`, so nothing else fits through it. */
async function metaRead(auth: ResolvedAuth, path: string, action: string): Promise<Response> {
  const req = metaRequest(auth, path, { method: "GET" }, TIMEOUT_MS);
  return fetchReadOrExplain(req.url, req.init, action, TIMEOUT_MS);
}

/**
 * What this call addressed, so a 403 can say whether the workspace binding is
 * what refused it. These routes all address the credential's own instance —
 * a tenant is named in the PATH here, not by swapping the host.
 */
function binding(auth: ResolvedAuth, workspaceId: number): BindingContext {
  return {
    boundWorkspaceId: auth.workspaceId,
    instance: auth.instance,
    profile: auth.profile,
    addressedWorkspaceId: workspaceId,
    credentialType: auth.credentialType,
    tenantHost: false,
  };
}

/** A read's 2xx body, or the status failure. Host and a summary, never the body — see `notJsonError`. */
async function readText(res: Response, action: string, bind?: BindingContext): Promise<string> {
  const text = await readBodyText(res, action);
  if (!res.ok) throw new TenantHttpError(res.status, action, res.statusText, text, bind);
  return text;
}

/** A tenant record is one only when it carries the tenant's name — the handle every caller acts on. */
const isTenantRow = (row: Record<string, unknown>): boolean => hasString(row, "name");

function base(workspaceId: number): string {
  return `/api:meta/workspace/${workspaceId}/tenant`;
}

/** The largest page the list route serves; asking for more is refused. */
const PER_PAGE = 100;

/**
 * Every tenant on the instance.
 *
 * Walked to exhaustion for the same reason the release list is: the route
 * paginates, and a tenant missing from a truncated first page reads as a
 * tenant that does not exist.
 */
export async function listTenants(
  auth: ResolvedAuth,
  opts: { workspaceId: number },
): Promise<TenantSummary[]> {
  const out: TenantSummary[] = [];
  for (let page = 1; ; page++) {
    const path = `${base(opts.workspaceId)}?page=${page}&per_page=${PER_PAGE}`;
    const res = await metaRead(auth, path, "list tenants");
    const url = new URL(path, auth.instance).href;
    // Bare or wrapped, every row a tenant: a page of junk is refused, never read as "no tenants".
    const { rows } = listAnswer(await readText(res, "list tenants", binding(auth, opts.workspaceId)), "list tenants", url, isTenantRow, {
      safe: true,
    });
    for (const r of rows) out.push(projectTenantRecord(r, auth.instance));
    if (rows.length < PER_PAGE) return out;
  }
}

/** One tenant by name. `null` when there is no such tenant. */
export async function getTenant(
  auth: ResolvedAuth,
  opts: { workspaceId: number; name: string },
): Promise<TenantSummary | null> {
  const path = `${base(opts.workspaceId)}/${encodeURIComponent(opts.name)}`;
  const res = await metaRead(auth, path, "get tenant");
  if (res.status === 404) {
    await res.text().catch(() => "");
    return null;
  }
  const url = new URL(path, auth.instance).href;
  const text = await readText(res, "get tenant", binding(auth, opts.workspaceId));
  return projectTenantRecord(recordAnswer(text, "get tenant", url, isTenantRow, { safe: true }), auth.instance);
}

/**
 * Whether a tenant's own host holds a workspace yet.
 *
 * A tenant served on its own domain has no workspace until its first release
 * lands: its workspace list answers `[]`, and every per-workspace route there
 * answers 404 "Invalid workspace". `false` only on that positive answer — a
 * bare empty array. Any other answer, including a failure, is `true`, so the caller
 * goes on to the reads that report their own failures.
 *
 * `base` is the tenant's URL, APPENDED to (it may carry a path prefix).
 */
export async function tenantHasWorkspace(auth: ResolvedAuth, base: string): Promise<boolean> {
  const url = `${base.replace(/\/$/, "")}/api:meta/workspace`;
  try {
    // An absolute URL: `metaRead` resolves it as it stands, on the tenant's host.
    const res = await metaRead(auth, url, "list the tenant's workspaces");
    const text = await res.text();
    if (!res.ok) return true;
    // The route answers a bare array; anything else is not the answer that says "none".
    const data: unknown = JSON.parse(text);
    return !(Array.isArray(data) && data.length === 0);
  } catch {
    return true;
  }
}

/**
 * One microservice's outcome from a tenant deploy, as the route reports it.
 *
 * An allow-list of the four fields an entry declares. `status` is passed
 * through as the server spells it (`ok`, `error`, `skipped`, …) rather than
 * mapped, so a status this SDK has not seen still reaches the caller.
 *
 * The shape is the one the route declares; no response carrying a failed
 * microservice has been recorded yet.
 */
export interface TenantMicroserviceOutcome {
  id?: number;
  name: string;
  status: string;
  /** The server's explanation, when it gave one. Flattened and capped. */
  detail?: string;
}

/**
 * What a landed tenant deploy answered.
 *
 * The route answers with the tenant record as it stands after the landing,
 * plus the microservices it reconciled. A microservice that failed to come up
 * does NOT fail the route: this 200 is the only place that failure is said, so
 * the body is read rather than discarded.
 */
export interface TenantDeployOutcome {
  /** When the release landed, as ISO 8601 UTC — the value `tenant get` will report. */
  deployedAt: string | undefined;
  /** The release the tenant now records as deployed. */
  deployedReleaseId: number | undefined;
  microservices: TenantMicroserviceOutcome[];
}

/** Whether a microservice outcome is a failure, rather than up or deliberately skipped. */
export function isFailedMicroservice(m: TenantMicroserviceOutcome): boolean {
  return /^(error|failed)$/i.test(m.status);
}

/** Long enough for a sentence; short enough that an entry cannot carry a dump. */
const MAX_MICROSERVICE_DETAIL = 300;

function projectMicroservice(raw: unknown): TenantMicroserviceOutcome | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || typeof r.status !== "string") return undefined;
  const id = typeof r.microservice_id === "number" && r.microservice_id > 0 ? r.microservice_id : undefined;
  const detail = typeof r.detail === "string" && r.detail.trim() !== "" ? capDetail(r.detail) : undefined;
  return {
    ...(id === undefined ? {} : { id }),
    name: r.name,
    status: r.status,
    ...(detail === undefined ? {} : { detail }),
  };
}

function capDetail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_MICROSERVICE_DETAIL ? `${flat.slice(0, MAX_MICROSERVICE_DETAIL)}…` : flat;
}

/**
 * Read a landed deploy's body: the tenant record after the landing. Lenient on
 * its FIELDS — a field this cannot read must not turn a landed release into a
 * failure — but not on whether it is the answer at all: a page, `null`, an
 * array or a stranger's object answering 200 says nothing about the landing,
 * so it is refused as a write whose outcome is unknown.
 */
function readDeployOutcome(text: string, action: string, url: string): TenantDeployOutcome {
  const record = recordAnswer(
    text,
    action,
    url,
    (row) => hasString(row, "name") || "deployed_at" in row || Array.isArray(row.microservices) || isRecord(row.release),
    { safe: true, write: true },
  );
  const list = Array.isArray(record.microservices) ? record.microservices : [];
  return {
    deployedAt: asTimestamp(record.deployed_at),
    deployedReleaseId: relationId(record.release),
    microservices: list.flatMap((m) => projectMicroservice(m) ?? []),
  };
}

/**
 * Why a tenant refused a deploy with 403, and what to do about it.
 *
 * Not the workspace-binding explanation the other routes attach. This route
 * addresses the credential's own workspace, and a 403 from it is the tenant's
 * deploy gate: a tenant can require an approved deployment request before a
 * release lands on it, and deploying needs the deploy permission on tenants.
 * Sending the reader to `--profile` would send them to a different credential
 * for a refusal no credential swap fixes.
 */
const DEPLOY_REFUSED_REMEDY =
  `The tenant refused the deploy, and nothing was landed. A tenant can require an approved ` +
  `deployment request before a release lands on it, and deploying needs permission to deploy to ` +
  `tenants in this workspace. Get the deployment approved (or the permission granted), then run it again.`;

/**
 * Land a release onto a tenant.
 *
 * The release is named in the BODY, as `release_name`. This route and the
 * workspace's own `release/<name>/deploy` are not symmetric: that one carries
 * the release in the PATH and uses the body for `branch` / `set_live`, so there
 * is no shared shape to infer this one from. Sending `release` — the name the
 * option carries on this side — is answered `400 Missing param: release_name`,
 * with nothing landed.
 */
export async function deployReleaseToTenant(
  auth: ResolvedAuth,
  opts: { workspaceId: number; tenant: string; release: string },
): Promise<TenantDeployOutcome> {
  const path = `${base(opts.workspaceId)}/${encodeURIComponent(opts.tenant)}/deploy`;
  const res = await metaWrite(
    auth,
    path,
    "deploy release to tenant",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ release_name: opts.release }),
    },
    DEPLOY_TIMEOUT_MS,
  );
  const text = await readBodyText(res, "deploy release to tenant", { aftermath: SENT_AFTERMATH });
  if (!res.ok) {
    // A 403 gets the deploy-gate remedy INSTEAD of the binding one — see
    // DEPLOY_REFUSED_REMEDY for why the binding one is wrong here.
    if (res.status === 403) {
      throw new TenantHttpError(res.status, "deploy release to tenant", res.statusText, text, undefined, DEPLOY_REFUSED_REMEDY);
    }
    throw new TenantHttpError(res.status, "deploy release to tenant", res.statusText, text, binding(auth, opts.workspaceId));
  }
  return readDeployOutcome(text, "deploy release to tenant", new URL(path, auth.instance).href);
}

/** Delete a tenant. An already-absent tenant is gone, not an error. */
export async function deleteTenant(
  auth: ResolvedAuth,
  opts: { workspaceId: number; name: string },
): Promise<{ alreadyGone: boolean }> {
  const path = `${base(opts.workspaceId)}/${encodeURIComponent(opts.name)}`;
  const res = await metaWrite(auth, path, "delete tenant", { method: "DELETE" });
  const text = await readBodyText(res, "delete tenant", { aftermath: SENT_AFTERMATH });
  if (res.status === 404) return { alreadyGone: true };
  if (!res.ok) {
    // A 5xx failed somewhere inside the delete, which may have run; a 4xx refused it.
    throw new TenantHttpError(
      res.status,
      "delete tenant",
      res.statusText,
      text,
      binding(auth, opts.workspaceId),
      writeStatusAftermath(res.status),
    );
  }
  // A 2xx is a delete only when it carries the route's success answer (`null`):
  // a page, `{}`, `[]` or an empty body deleted nothing we can know of, so it is
  // refused as a write whose outcome is unknown.
  deleteAnswer(text, "delete tenant", new URL(path, auth.instance).href, { safe: true });
  return { alreadyGone: false };
}

/**
 * A scoped session for opening the tenant's dashboard.
 *
 * `guest` asks for a read-only session, as it does for an ephemeral: the route
 * is the same one and reads the same query parameter.
 *
 * The returned value is a credential. Callers hand it to a browser or print it
 * only when explicitly asked; it is not part of any summary.
 */
export async function impersonateTenant(
  auth: ResolvedAuth,
  opts: { workspaceId: number; name: string; guest?: boolean },
): Promise<ImpersonateToken> {
  // Delegated rather than re-implemented: an ephemeral IS a tenant, so this is
  // the same route, and the copy here had drifted from it in two ways that
  // matter — it sent POST to a GET route, and it returned the response whole.
  // That response mints an auth token, so returning it whole put a credential
  // in reach of `--json`, which is exactly what lands in a CI log.
  return impersonateEphemeral(auth, { parentWorkspaceId: opts.workspaceId, name: opts.name, guest: opts.guest });
}
