/**
 * Which write requests are on the wire right now, for the Ctrl-C handler.
 *
 * A signal ends the process synchronously, so no `catch` in the command runs,
 * and a write already sent keeps going on the server after we exit. Reporting
 * "Cancelled." over it claims an outcome nobody knows. Every command that
 * writes would have to remember to say so; instead the bin wraps the global
 * `fetch` once ({@link installSentWriteTracking}) and every write request is
 * recorded from the moment it is handed to the network until it is answered,
 * whichever code path sent it.
 *
 * A write is any request that is not GET/HEAD/OPTIONS to an instance's meta
 * API, less the POSTs that change nothing: a preview (`dry_run=true`), an
 * export, a test or function run. Anything else is counted — a read wrongly
 * counted says "may have completed" over nothing, which is the safe mistake.
 *
 * The caller says what the write is and how to check it with
 * {@link describeWrite}; a write sent with no description is reported as "a
 * write to <host>".
 *
 * Imports nothing of the SDK's own: the bin loads it before any command.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** What a write is, in the reader's words, and how to learn whether it landed. */
export interface WriteDescription {
  /** The write as the interrupt line names it: `the import into ephemeral "e4f2-…"`. */
  what?: string;
  /** The read-only command that settles it, printed as `Check with \`…\` before retrying.` */
  resolveWith?: string;
  /** The same as a whole sentence, for a check that is not one command. Wins over `resolveWith`. */
  check?: string;
}

/** One write on the wire. */
export interface SentWrite extends WriteDescription {
  /** Where it went (origin only — never the route or its query). */
  host: string;
  /** A change to the project on disk (a package install) rather than a request. */
  local?: boolean;
}

const described = new AsyncLocalStorage<WriteDescription>();
const inFlight = new Set<SentWrite>();

/**
 * Run `fn` with every write it sends described as `description`. Nested calls
 * merge: an inner field the caller left out keeps the outer one, so a command
 * can name the check and the transport the write.
 */
export function describeWrite<T>(description: WriteDescription, fn: () => Promise<T>): Promise<T> {
  const outer = described.getStore();
  const merged: WriteDescription = { ...outer };
  for (const key of ["what", "resolveWith", "check"] as const) {
    if (description[key] !== undefined) merged[key] = description[key];
  }
  return described.run(merged, fn);
}

/** The POST routes under the meta API that change nothing. */
const READ_POST = /\/(export|run)$/;

/** Whether a request with this method and URL is a write, by the rule in the module comment. */
export function isWriteRequest(method: string, url: string): boolean {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!parsed.pathname.includes("/api:meta/")) return false;
  if (parsed.searchParams.get("dry_run") === "true") return false;
  return !READ_POST.test(parsed.pathname.replace(/\/$/, ""));
}

/** The most recently sent write still waiting on its answer, if any. */
export function pendingWrite(): SentWrite | undefined {
  let last: SentWrite | undefined;
  for (const write of inFlight) last = write;
  return last;
}

/**
 * `fetchImpl`, recording each write from the moment it is sent until it is
 * answered (or fails).
 */
export function trackingFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    if (!isWriteRequest(method, url)) return fetchImpl(input, init);
    const write: SentWrite = { host: new URL(url).origin, ...described.getStore() };
    inFlight.add(write);
    try {
      return await fetchImpl(input, init);
    } finally {
      inFlight.delete(write);
    }
  };
}

let installed = false;

/** Wrap the global `fetch` with {@link trackingFetch}. Idempotent. */
export function installSentWriteTracking(): void {
  if (installed) return;
  installed = true;
  globalThis.fetch = trackingFetch(globalThis.fetch.bind(globalThis));
}

/**
 * Run `fn` — a change to the project on disk that cannot be taken back once
 * started, such as a package-manager install — with it counted as a pending
 * write. An interrupt while it runs then says the change may have completed
 * and names `description`'s check, instead of "Cancelled." over a
 * `package.json` that already holds it.
 */
export async function trackLocalWrite<T>(description: WriteDescription, fn: () => Promise<T>): Promise<T> {
  const write: SentWrite = { host: "this project", local: true, ...description };
  inFlight.add(write);
  try {
    return await fn();
  } finally {
    inFlight.delete(write);
  }
}

/**
 * What this run has already landed, for an interrupt that comes after it: the
 * deploy that landed before its rename or static publish was cut off, the
 * environment a create made before its readiness wait was.
 */
export interface LandedStep {
  /** The landed part as a sentence: `Deployed ephemeral "app" (e1) (full replace).` */
  said: string;
  /**
   * What to say instead of {@link said} when the interrupt finds nothing else
   * on the wire — the way on from what stands. Omitted, `said` is said.
   */
  ifCancelled?: string;
  /** Fields the interrupt's JSON document carries beside `landed`. */
  fields?: Record<string, unknown>;
}

let landed: LandedStep | undefined;

/** Record what this run has landed so far; `undefined` forgets it. */
export function noteLanded(step: LandedStep | undefined): void {
  landed = step;
}

/** What this run has landed so far, if anything. */
export function landedStep(): LandedStep | undefined {
  return landed;
}
