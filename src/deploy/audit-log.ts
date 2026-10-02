/**
 * Node-only transport for the workspace audit log, read for exactly one
 * question: **did the server cut this release from the source we named?**
 *
 * The release-create route accepts a source tenant, and an instance that
 * predates that capability does not reject the parameter — it drops it and cuts
 * from the workspace instead, answering `200`. Nothing in the create response
 * distinguishes the two: the record carries a name, a branch, and its tables,
 * and no trace of where the bytes came from. The audit log is the one surface
 * that records it, so this module reads that and projects the answer.
 *
 * **Everything is projected.** An audit row carries the acting user, the
 * workspace, and an arbitrary `data` payload written by whichever route logged
 * it. None of that is this caller's business, and all of it lands in shell
 * history and CI logs, so {@link ReleaseSource} is what leaves here.
 *
 * Deliberately narrow: this is not a general audit-log client. It answers the
 * provenance question and nothing else, because a general one would invite
 * callers to read rows this module has no projection for.
 */
import type { ResolvedAuth } from "../auth/token.js";
import { fetchOrExplain, safeHttpFailure, parseJsonAnswer } from "../util/http.js";

/** Bound the call so a stalled endpoint cannot hang the CLI or CI. */
const TIMEOUT_MS = 30_000;

/**
 * Entries per page, and how many pages a lookup may walk.
 *
 * The confirmation after a cut finds its entry on the first page. A later
 * lookup — `release show`, a landing's password-hash origin — may be asked
 * about a release cut weeks and hundreds of entries ago, so it pages back until
 * it finds the entry, reaches entries older than the release (`notBefore`), or
 * runs out. A single fixed window lost every release's origin after 25 later
 * entries. Bounded all the same: the log is pruned on most plans, so an old
 * enough entry is not there to find, and the release's own record is where a
 * durable origin lives (see `ORIGIN_MARKER` in `release.ts`).
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** An audit row's time, in epoch ms, from either spelling the route uses. */
function rowTime(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(t) ? undefined : t;
}

/** Where a release's contents were read from, as the audit entry recorded it. */
export interface ReleaseSource {
  /** The tenant the server actually resolved — not the string we asked with. */
  tenantName: string;
  /** `ephemeral` or `sandbox`; the server refuses every other type. */
  tenantType: string | undefined;
  /** Whether the archive carried table records, not just schema and logic. */
  records: boolean;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** A page's rows, whether the route answers bare or wrapped. */
function pageRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const items = obj(body)?.items;
  return Array.isArray(items) ? items : [];
}

/**
 * The source recorded for a named release, or `null` when no entry claims one.
 *
 * `null` is the answer for BOTH "this instance ignored the source parameter"
 * and "this release was legitimately cut from the workspace", which is why the
 * caller must only ask when it actually named a source. Distinguishing them
 * here is not possible and pretending otherwise would push a wrong reading one
 * layer down.
 *
 * Throws when the log cannot be read. That is deliberate and the caller must
 * not soften it: an instance that cannot say where it cut from is, from here,
 * indistinguishable from one that cut from the wrong place — the same reasoning
 * `assertBranchReadSupported` applies to a missing branch signal on the read
 * side.
 */
export async function findReleaseSource(
  auth: ResolvedAuth,
  opts: {
    workspaceId: number;
    releaseName: string;
    /**
     * Stop at entries older than this (epoch ms): the release's creation, less
     * a margin. Without it a lookup walks up to its page bound.
     */
    notBefore?: number;
  },
): Promise<ReleaseSource | null> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = await readPage(auth, opts.workspaceId, page);
    for (const row of rows) {
      const entry = obj(row);
      if (entry === undefined || entry.type !== "release:create") continue;

      const data = obj(entry.data);
      // Match on the release the entry names, not on being newest. Two cuts
      // racing on one workspace would otherwise confirm each other's provenance.
      // The entry records the name the server STORED, which is unique per
      // workspace because a taken one is suffixed on write — so the caller must
      // pass that name, never the one it asked for.
      if (asString(obj(data?.release)?.name) !== opts.releaseName) continue;

      const source = obj(data?.source);
      const tenantName = asString(source?.tenant_name);
      if (tenantName === undefined) return null;

      return {
        tenantName,
        tenantType: asString(source?.tenant_type),
        records: source?.records === true,
      };
    }
    // Newest first, so once a page reaches past the release's creation no
    // later page can hold its entry.
    if (rows.length < PAGE_SIZE) break;
    const oldest = rowTime(obj(rows.at(-1))?.created_at);
    if (opts.notBefore !== undefined && oldest !== undefined && oldest < opts.notBefore) break;
  }
  return null;
}

async function readPage(auth: ResolvedAuth, workspaceId: number, page: number): Promise<unknown[]> {
  const path =
    `/api:meta/workspace/${workspaceId}/audit_log` +
    `?page=${page}&per_page=${PAGE_SIZE}&include_data=true`;
  const action = "confirm the release source";

  const res = await fetchOrExplain(
    new URL(path, auth.instance).href,
    {
      method: "GET",
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${auth.access_token}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
    action,
    TIMEOUT_MS,
  );

  const text = await res.text();
  if (!res.ok) {
    // `status` rides on the error so a server error or rate limit reads as a
    // read that got no answer (exit 8 and the rerun), not as a refusal.
    throw auditLogHttpError(
      res.status,
      safeHttpFailure(action, res, text, {
        boundWorkspaceId: auth.workspaceId,
        instance: auth.instance,
        profile: auth.profile,
        addressedWorkspaceId: workspaceId,
        credentialType: auth.credentialType,
        // Always the credential's own instance — the audit log lives with the
        // workspace the release landed in, never on a tenant's host.
        tenantHost: false,
      }),
    );
  }
  // Host and a summary, never the body — see `notJsonError`.
  const body = parseJsonAnswer(text, action, res.url, { safe: true });
  return pageRows(body);
}

/** An audit-log read the instance answered with a failure status. */
function auditLogHttpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
