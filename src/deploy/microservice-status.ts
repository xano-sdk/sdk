/**
 * Node-side readiness check for a deploy's MICROSERVICES: read every
 * microservice in the target workspace and wait for the ones still coming up.
 *
 * A workspace import restores microservice rows and the engine brings up the
 * ones that opt in (`tenant_deploy: "auto"`); `manual` and `disabled` rows are
 * carried but never started. The import call returns as soon as the objects
 * land, so a deploy that reported success can still be minutes away from a
 * microservice actually serving traffic — which is what a stack reaching
 * `s.microservice.request` depends on. This closes that gap the same way
 * {@link verifyRollout} closes it for the static host.
 *
 * ### Which route, and why it matters
 *
 * The read is `GET {base}/api:meta/workspace/{id}/microservice` — the same
 * `{base}/api:meta/workspace/{id}/…` pair the import itself uses, so one call
 * shape serves every scope: an ephemeral (its own base URL, workspace `1`), the
 * and a real workspace (the instance origin and the token's
 * workspace id). It is also a plain READ: it reports the status stored on each
 * row and has no side effect on it.
 *
 * That last part is the subtle one. Because this route reports stored state
 * rather than probing the cluster itself, a poll only advances as fast as the
 * engine refreshes the row. If a row's status were ever to freeze, polling
 * would not detect readiness on its own — so the wait below is bounded and
 * treats running out of budget as a warning for the caller to report, never as
 * a hang and never as a failed deploy.
 *
 * Nothing secret is carried out of here: the projection keeps identity and
 * status only, dropping the registry credential and chart values that the
 * microservice kind can hold.
 */
import type { ResolvedAuth } from "../auth/token.js";
import { READ_AFTERMATH, explainFetchFailure, httpFailure, readBodyText } from "../util/http.js";
import { hasString, listAnswer } from "./answer-shape.js";

/** Bound each read so a stalled endpoint can't hang the CLI/CI. */
const TIMEOUT_MS = 30_000;

/**
 * What a failed read is called in the sentence that reports it — in the SDK's
 * words, never the route's. A deploy prints it right after its import landed,
 * so it has to read as the status check it is.
 */
const MICROSERVICE_READ = "Microservice status read";
/** Poll cadence while at least one microservice is still coming up. */
const POLL_INTERVAL_MS = 2_000;
/** Hard stop for the whole wait. Past this the caller reports "not confirmed". */
const WAIT_DEADLINE_MS = 300_000;

/**
 * What a microservice is doing, derived from its row. `inFlight` is the only
 * disposition worth waiting on — every other one is already final, or is a row
 * the engine was never going to start.
 */
export type MicroserviceDisposition =
  /** Running and ready. */
  | "ready"
  /** Coming up: applied, not serving yet. */
  | "inFlight"
  /** Deployed and broken — `statusDetail` carries the engine's reason. */
  | "failed"
  /** `tenant_deploy: "manual"` — carried by the import, started by hand. */
  | "manual"
  /** Switched off on the row. */
  | "disabled"
  /** A status this SDK does not model. Reported verbatim, never awaited. */
  | "unknown";

/** The projected, safe-to-print view of one microservice. Never the raw row. */
export interface MicroserviceSummary {
  id: number | undefined;
  name: string;
  /** `builtin` (declared containers) or `helm` (a chart). */
  kind: string | undefined;
  /** `auto` (the engine starts it) or `manual` (you do). Defaults to `auto`. */
  tenantDeploy: string;
  /** The engine's raw status, kept so an unmodelled value stays reportable. */
  status: string;
  /** The engine's human-readable reason, when it set one. */
  statusDetail: string | undefined;
  /** When the workload was last started, or `undefined` if it never was. */
  deployedAt: string | undefined;
  disposition: MicroserviceDisposition;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * Derive a row's {@link MicroserviceDisposition}.
 *
 * Order matters. `disabled` is checked before `tenant_deploy` because a
 * disabled row is off regardless of how it would otherwise deploy, and
 * `tenant_deploy` is checked before status because a manual row's status
 * describes a workload the import was never going to start.
 *
 * An unrecognized status resolves to `unknown` rather than being guessed into
 * `inFlight`: a value this SDK has not seen must not be able to make the wait
 * below spin for the full budget.
 */
export function classify(row: { status?: string; tenantDeploy?: string }): MicroserviceDisposition {
  const status = row.status ?? "";
  if (status === "disabled") return "disabled";
  if ((row.tenantDeploy ?? "auto") === "manual") return "manual";
  switch (status) {
    case "ok": {
      return "ready";
    }
    case "error": {
      return "failed";
    }
    // `pending` is the state a freshly imported row sits in until the engine
    // picks it up; both it and `deploying` mean "not serving yet, keep looking".
    case "pending":
    case "deploying": {
      return "inFlight";
    }
    default: {
      return "unknown";
    }
  }
}

/** True for the one disposition the wait below actually blocks on. */
export function isAwaited(m: MicroserviceSummary): boolean {
  return m.disposition === "inFlight";
}

/** Project a raw row to the safe summary. Drops `registry_auth` and `chart`. */
function project(row: Record<string, unknown>): MicroserviceSummary {
  const tenantDeploy = asString(row.tenant_deploy) ?? "auto";
  const status = asString(row.status) ?? "";
  return {
    id: asNumber(row.id),
    name: asString(row.name) ?? "",
    kind: asString(row.kind),
    tenantDeploy,
    status,
    statusDetail: asString(row.status_detail),
    deployedAt: asString(row.deployed_at),
    disposition: classify({ status, tenantDeploy }),
  };
}

/**
 * A microservice row is one only when it carries its name. A page with a row
 * that does not — or a body that is no list at all — is refused whole: read as
 * "no microservices", it reported a deploy's workload as nothing to wait for.
 */
const isMicroserviceRow = (row: Record<string, unknown>): boolean => hasString(row, "name");

/** Where to read microservices from: an environment's base URL + workspace id. */
export interface MicroserviceTarget {
  /** The env's own base URL (an ephemeral) or the instance origin. */
  baseUrl: string;
  /** `1` inside an ephemeral; the token's workspace id otherwise. */
  workspaceId: number;
}

/** Injected fetch (tests supply a fake). */
export interface ListOptions {
  fetchFn?: typeof fetch;
}

/**
 * Read every microservice in the target workspace, newest page first.
 *
 * The URL is built by concatenation rather than `new URL(path, base)` so a base
 * that carries a `/tenant/{name}` prefix survives — the same rule the import
 * transport follows. Pages are followed to the end, so a workspace with more
 * microservices than one page is still reported in full.
 */
export async function listMicroservices(
  auth: ResolvedAuth,
  target: MicroserviceTarget,
  opts: ListOptions = {},
): Promise<MicroserviceSummary[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const root = `${target.baseUrl.replace(/\/$/, "")}/api:meta/workspace/${target.workspaceId}/microservice`;

  const out: MicroserviceSummary[] = [];
  let page = 1;
  for (;;) {
    const url = `${root}?page=${page}`;
    // A dead connection is said the host-only way every transport says it —
    // "Microservice status read could not reach <instance>: …" — never a bare
    // `fetch failed`.
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "GET",
        headers: { accept: "application/json", Authorization: `Bearer ${auth.access_token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw explainFetchFailure(err, { url, what: MICROSERVICE_READ, timeoutMs: TIMEOUT_MS, aftermath: READ_AFTERMATH });
    }
    // A drop mid-body is said the same way (host only), never a bare `terminated`.
    const text = await readBodyText(res, MICROSERVICE_READ, { url, timeoutMs: TIMEOUT_MS });
    if (!res.ok) {
      throw new Error(httpFailure(MICROSERVICE_READ, res, text));
    }
    const { rows, envelope } = listAnswer(text, MICROSERVICE_READ, url, isMicroserviceRow);
    out.push(...rows.map((r) => project(r)));

    // Only the paged envelope can carry a next page; a bare array is the whole set.
    const next = envelope?.nextPage;
    if (typeof next !== "number" || next <= page) return out;
    page = next;
  }
}

export interface WaitResult {
  /** The last set of rows observed. */
  microservices: MicroserviceSummary[];
  /** True when the budget elapsed with something still coming up. */
  timedOut: boolean;
  /** True when any microservice reports a hard failure. */
  hadFailure: boolean;
}

/** Injected clock/fetch plus the one timing knob a test overrides. */
export interface WaitOptions extends ListOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Hard stop for the whole wait (default 300s). */
  totalDeadlineMs?: number;
  pollIntervalMs?: number;
  /** Called after each read, for progress rendering. */
  onPoll?: (microservices: MicroserviceSummary[]) => void;
}

/**
 * Read once, then keep reading while anything is still coming up.
 *
 * Always performs at least one read, so a caller gets a report even when
 * everything settled between the import and the first look. Returns immediately
 * when nothing is awaited — the overwhelmingly common case is a workspace with
 * no microservices at all, and it must cost exactly one request.
 *
 * A transient read failure keeps the loop alive rather than aborting it: a pod
 * restarting behind the meta API is a blip, and the deadline is the real
 * failure signal. Never rejects on a read — only a caller-visible
 * `timedOut`/`hadFailure` comes back, because the import has already committed
 * by the time this runs and nothing here should undo that.
 */
export async function waitForMicroservices(
  auth: ResolvedAuth,
  target: MicroserviceTarget,
  opts: WaitOptions = {},
): Promise<WaitResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const totalDeadlineMs = opts.totalDeadlineMs ?? WAIT_DEADLINE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;

  const start = now();
  let microservices: MicroserviceSummary[] = [];
  let sawAnyRead = false;

  for (;;) {
    try {
      microservices = await listMicroservices(auth, target, opts);
      sawAnyRead = true;
      opts.onPoll?.(microservices);
      if (!microservices.some((m) => isAwaited(m))) {
        return { microservices, timedOut: false, hadFailure: microservices.some((m) => m.disposition === "failed") };
      }
    } catch (err) {
      // The very first read failing is different from a mid-poll blip: there is
      // nothing to report and no reason to believe a retry helps, so surface it
      // and let the caller decide (it warns — see the deploy command).
      if (!sawAnyRead) throw err;
    }

    if (now() - start + pollIntervalMs > totalDeadlineMs) {
      return {
        microservices,
        timedOut: true,
        hadFailure: microservices.some((m) => m.disposition === "failed"),
      };
    }
    await sleep(pollIntervalMs);
  }
}
