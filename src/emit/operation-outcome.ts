/**
 * Did a consequential write happen? The one place that answers it from a thrown
 * error, and the one place that knows a write is in flight.
 *
 * Every release write (`release create`, `promote`, `tenant deploy` and
 * `release transfer`) sends one request that may run for minutes on the server.
 * When that request fails, the failure alone often cannot say whether the
 * server finished the work: a reset connection, a gateway 502 or our own
 * deadline all arrive the same way whether the server stopped at the first byte
 * or completed everything and lost the reply. Reporting any of those as
 * "failed" invites a retry, and a retried cut or landing is a duplicate. So the
 * answer here is three-valued, and the middle value is the default:
 *
 * - `no`: the write did not happen, and retrying is safe. Only claimed where the
 *   error PROVES it: nothing was sent yet, the CLI refused its own input, the
 *   server refused the request (4xx), or the connection never opened.
 * - `unknown`: everything else. The caller settles it with a read before doing
 *   anything that writes again.
 *
 * `no` is an allow-list rather than `unknown` being a deny-list because the two
 * mistakes are not the same size. A wrong `unknown` costs one read. A wrong `no`
 * mints a duplicate release or lands a branch twice.
 *
 * Knowing a write is in flight is `operation-registry.ts`'s half, kept apart
 * because the interrupt handler loads at startup and this module loads the
 * transports it classifies.
 */
import { ReleaseHttpError } from "../deploy/release.js";
import { TenantHttpError } from "../deploy/tenant.js";
import { BranchHttpError, BranchTakenError } from "../deploy/branch.js";
import { ImportHttpError } from "../deploy/import.js";
import { isTimeoutError, TLS_CERTIFICATE_CODES, writeRefusedBy } from "../util/http.js";
import { UsageError } from "./errors.js";
import { SourceError } from "./source-resolve.js";

/** The answer to "did the requested outcome come to exist", for a failure. */
export type FailureOutcome = "no" | "unknown";

/**
 * A write failure the command has settled from the server's own answer: the
 * request ran and stopped on something deterministic (a data constraint the
 * release breaks), so the requested outcome does not exist and sending it again
 * fails the same way until something changes. Classified `no` whatever status
 * carried it. The command, not this module, says what the stop left behind.
 */
export class SettledWriteFailure extends Error {
  override readonly name = "SettledWriteFailure";
}

/**
 * Transport errors whose codes say the connection never opened, so the request
 * was never received. A DNS miss, a refused port and an unreachable network all
 * fail before a single byte of the body leaves.
 *
 * Deliberately short. `ETIMEDOUT` is not here: it is raised for a connect that
 * stalled but also for a socket that went quiet mid-request, and the error does
 * not say which.
 */
const NEVER_OPENED: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  // A certificate the TLS handshake refused: the connection closed before a
  // request was written.
  ...TLS_CERTIFICATE_CODES,
]);

/** How far down a cause chain to look before giving up. Real chains are three deep. */
const MAX_CHAIN = 16;

/** The HTTP-status-carrying errors the write transports throw. */
function httpStatusOf(err: unknown): number | undefined {
  if (
    err instanceof ReleaseHttpError ||
    err instanceof TenantHttpError ||
    err instanceof BranchHttpError ||
    err instanceof ImportHttpError
  ) {
    return err.status;
  }
  return undefined;
}

/**
 * Every error in `err`'s chain: itself, its `cause`s, and the attempts of any
 * `AggregateError` (a dual-stack connect reports one refusal per address).
 *
 * The transports wrap the `fetch` failure once to phrase it, and `fetch` puts
 * the reason one level further down, so an errno is typically two causes deep —
 * never on the error a caller catches.
 */
function chainOf(err: unknown): unknown[] {
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  const queue: unknown[] = [err];
  while (queue.length > 0 && out.length < MAX_CHAIN) {
    const next = queue.shift();
    if (next === undefined || next === null || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (typeof next !== "object") continue;
    const cause = (next as { cause?: unknown }).cause;
    if (cause !== undefined) queue.push(cause);
    const errors = (next as { errors?: unknown }).errors;
    if (Array.isArray(errors)) queue.push(...errors);
  }
  return out;
}

/**
 * Classify a failure as `no` or `unknown`.
 *
 * `writeSent` is whether the request that changes something had been handed to
 * the network when this was thrown. Before that point nothing can have
 * happened on the server, whatever the error is — a failed read, a refused
 * precondition, a bug.
 *
 * During a write, `no` needs positive evidence:
 * - a `UsageError` or `SourceError` — the CLI's own refusals, raised before
 *   anything is sent;
 * - a 4xx from a write transport — the server refused the request as a whole;
 * - a {@link SettledWriteFailure} — the command read a deterministic stop in
 *   the server's answer;
 * - transport codes that ALL say the connection never opened.
 *
 * Anything else is `unknown`, including our own timeout, a reset or broken pipe,
 * the HTTP client's own header timeout or socket error, a 5xx, a 2xx whose body
 * could not be read, and anything this function has never seen.
 */
export function classifyFailure(err: unknown, opts: { writeSent: boolean }): FailureOutcome {
  if (!opts.writeSent) return "no";
  const chain = chainOf(err);

  // Our own refusals first: they are thrown by the CLI, never by the network.
  // A taken branch label is decided before anything lands, even when the
  // instance is the one that noticed it (a concurrent landing's duplicate).
  if (
    chain.some(
      (e) =>
        e instanceof UsageError ||
        e instanceof SourceError ||
        e instanceof BranchTakenError ||
        e instanceof SettledWriteFailure,
    )
  )
    return "no";

  // A status wins over any code: the server answered, so the connection opened.
  for (const e of chain) {
    const status = httpStatusOf(e);
    if (status !== undefined) return writeRefusedBy(status) ? "no" : "unknown";
  }

  // A deadline anywhere means the request was abandoned, not refused.
  if (chain.some(isTimeoutError)) return "unknown";
  // The HTTP client refuses a blocked port before it connects.
  if (chain.some((e) => e instanceof Error && e.message === "bad port")) return "no";

  const codes = chain
    .map((e) => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined))
    .filter((c): c is string => typeof c === "string");
  if (codes.length > 0 && codes.every((c) => NEVER_OPENED.has(c))) return "no";
  return "unknown";
}
