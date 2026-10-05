/**
 * From a parsed {@link Source} to something a command can actually address.
 *
 * `source-selector.ts` decides what an argument NAMES. This decides whether
 * that thing is there, and where to send calls if it is.
 *
 * ## Three outcomes, not one
 *
 * The gate this replaces answers "expired or no longer exists" for both
 * states, which was fine when an ephemeral was the only thing a command could
 * be pointed at and `xanosdk deploy` was the fix for either. With six kinds the
 * states need different fixes and so need different names:
 *
 * - **gone** — nothing carries that name. The fix is a correction: check the
 *   spelling, or list what does exist.
 * - **expired** — it existed and its lifetime ran out. The fix is to make a new
 *   one; the old name is not coming back.
 * - **unreachable** — it exists and is not answering. The fix is to wait or to
 *   look at the instance, and NOT to create anything, which is the action the
 *   other two invite and which would be wrong here.
 *
 * A single "not found" for all three sends a user down the wrong one, and sends
 * CI down it repeatedly.
 *
 * ## Clearing what it invalidates
 *
 * Resolving an ephemeral that has gone clears this project's tracked record of
 * it. That side effect is why a second `xanosdk deploy` works after a sweep
 * rather than failing forever against a name nothing answers to, and it belongs
 * here rather than in one command's gate — every path that resolves a source
 * needs it, not only the environment subcommands.
 *
 * A resolve that SUCCEEDS never writes anything.
 *
 * ## A credential only when the kind needs one
 *
 * Every hosted kind is looked up THROUGH a Xano credential, so the resolver
 * takes a provider rather than a credential and awaits it once, inside the
 * hosted arms. A Xano Engine selects no credential at all — its bearer comes
 * off the engine's own enumeration — so the local arm never calls the provider.
 * Taking a ready credential instead would force every caller to read one
 * before knowing the kind, and a run with nobody logged in could then never
 * reach an engine on its own machine.
 *
 * The result says which of the two it was ({@link ResolvedBackend}) and carries
 * the two-field {@link BearerTarget} derived from either, which is what every
 * transport takes. The whole engine value rides along on the local arm because
 * a bearer alone cannot mint an engine login link, and `impersonate` needs one.
 *
 * ## The local arm keeps the Xano Engine invariants
 *
 * The engine's own enumeration is the liveness oracle and a record is only a
 * hint: a recorded engine the enumeration does not show is stale, and its
 * record is cleared before the refusal says so — the same bookkeeping a gone
 * ephemeral gets. An engine reporting a url off loopback is unreachable, and
 * clears nothing: it is running, just not somewhere its bearer may follow, so
 * that check happens before any bearer leaves this function.
 */
import type { BearerTarget, ResolvedAuth } from "../auth/token.js";
import { getEphemeral, isExpired, type EphemeralSummary } from "../deploy/ephemeral.js";
import { getTenant, tenantHasWorkspace } from "../deploy/tenant.js";
import { isSignatureRefusal } from "../deploy/import.js";
import { findRelease, listReleases, type ReleaseSummary } from "../deploy/release.js";
import { clearEnvironment, getEnvironment, readEphemeralState } from "../deploy/ephemeral-state.js";
import { EXIT_SOURCE_UNRESOLVABLE, type Source, type SourceKind } from "./source-selector.js";
import { resolveEphemeralName, type MetaTarget } from "./env-target.js";
import {
  bindingFor,
  certificateFailureCode,
  isTimeoutError,
  lastRateLimitRetryAfter,
  TransportError,
  UNTRUSTED_CERTIFICATE,
  type BindingContext,
} from "../util/http.js";
import { contextFlags } from "./context-flags.js";
import { pipedYes } from "./retry-command.js";
import { CliError } from "./errors.js";
import { shellQuote } from "../util/shell-quote.js";
import { suggest } from "./commands.js";
import { suggestAll } from "../util/suggest.js";
import { orNamesNoted } from "./name-normalisation.js";
import { assertLoopbackUrl, type LocalEngine } from "../deploy/local-engine-handshake.js";
import { clearEngineRecordsNamed, getEngineRecord, listEngineRecords } from "../deploy/local-engine-state.js";
import {
  displayNameHint,
  displayNameOwner,
  isShared,
  nearBackendLines,
  nearBackendName,
  selectorFix,
  sentenceCase,
  sharedDisplayHint,
  type DisplayNamedKind,
  type DisplayOwner,
  type DisplayOwnerRow,
  type NearBackend,
  type SharedDisplay,
} from "./display-name-hint.js";

/** Why a source could not be addressed. */
export type Liveness = "gone" | "expired" | "unreachable";

/**
 * A source that named something, but not something usable.
 *
 * Carries `exitCode` so every command that takes a source fails with the same
 * one — a CI wrapper retries this case, because an environment swept between
 * two steps is the common cause, and investigates everything else.
 */
export class SourceError extends Error {
  readonly exitCode = EXIT_SOURCE_UNRESOLVABLE;
  constructor(
    message: string,
    readonly liveness: Liveness,
    readonly kind: SourceKind,
    /** The near name the message suggests — the failure document's `suggestion`. */
    readonly suggestion?: string,
    /** Every near name a tie named, `suggestion` first — the failure document's `suggestions`. */
    readonly suggestions?: readonly string[],
  ) {
    super(message);
    this.name = "SourceError";
  }
}

/**
 * Yields the Xano credential a hosted kind is looked up through.
 *
 * A function, not a value, so the local arm can decline to call it — see the
 * module header. Awaited at most once per resolve.
 */
export type CredentialProvider = () => Promise<ResolvedAuth>;

/**
 * The provider for a caller that holds no credential and names only a local
 * engine. Calling it is a bug in the caller's routing, not a user mistake, so
 * it says so rather than suggesting a login.
 */
export const NO_CREDENTIAL: CredentialProvider = () =>
  Promise.reject(new Error("Internal: a hosted source was resolved without a credential provider."));

/**
 * Which backend a resolved source is served by.
 *
 * - **hosted** — the credential it was looked up through, and the binding a
 *   403 from it is explained against. The binding is optional in the type only
 *   so a caller can build one by hand; the resolver always sets it.
 * - **local** — the whole engine value from the enumeration. Never written to
 *   disk or printed: it carries the bearer and a sign-in url.
 *
 * The field names differ on purpose (`auth` vs `engine`), for the reason
 * `LocalEngine` does not reuse `instance`/`access_token`: a Xano Engine that
 * type-checked as a hosted credential would be accepted by the hosted state
 * writer and explained by the hosted binding refusal.
 */
export type ResolvedBackend =
  | { kind: "hosted"; auth: ResolvedAuth; binding?: BindingContext }
  | { kind: "local"; engine: LocalEngine };

/** Where a resolved source lives, how it names itself, and how to call it. */
export interface ResolvedSource {
  target: MetaTarget;
  kind: SourceKind;
  /** How this source identifies itself in a tracked record: `release:main`. */
  provenance: string;
  /** The release, for the one kind that resolves to an object rather than a place. */
  release?: ReleaseSummary;
  backend: ResolvedBackend;
  /**
   * The url-and-token pair every transport takes, derived from {@link backend}:
   * the credential itself for a hosted kind, the engine's url and bearer for a
   * local one.
   */
  bearer: BearerTarget;
}

/**
 * The kind a resolved backend actually IS. An ephemeral is a tenant on the
 * wire, so `tenant:<name>` can name one — and a write to it is a write to a
 * throwaway, reported as one, not a real tenant's confirmation and receipt.
 * Everything a command SAYS about the target reads this, never the selector's
 * spelling. An absent type fails closed to what was typed.
 */
export function actualKind(resolved: Pick<ResolvedSource, "kind" | "target">): SourceKind {
  return resolved.kind === "tenant" && resolved.target.tenantType === "ephemeral" ? "ephemeral" : resolved.kind;
}

/**
 * How a human line names a resolved backend: `ephemeral "e4f2-…" ("My App")`,
 * `tenant "eu"`, `your workspace`, `your Xano Engine`. The display name rides
 * beside the name when the record carries a different one — it is what people
 * call the backend, and the name alone is a server-assigned handle.
 */
export function describeBackend(resolved: Pick<ResolvedSource, "kind" | "target" | "provenance">): string {
  const kind = actualKind(resolved);
  const { label, display } = resolved.target;
  const shown = display !== undefined && display !== "" && display !== label ? ` (${JSON.stringify(display)})` : "";
  switch (kind) {
    case "ephemeral":
    case "tenant":
      return `${kind} ${JSON.stringify(label)}${shown}`;
    case "workspace":
      return "your workspace";
    case "local":
      return resolved.provenance === "local" ? "your Xano Engine" : `Xano Engine ${JSON.stringify(label)}`;
    default:
      return label;
  }
}

/** Seams the tests replace; production callers pass nothing. */
export interface ResolveDeps {
  cwd?: string;
  getEphemeral?: typeof getEphemeral;
  getTenant?: typeof getTenant;
  findRelease?: typeof findRelease;
  /** Where Xano Engine records and the engine cache live. Defaults to the process env. */
  env?: NodeJS.ProcessEnv;
  /**
   * The engine's own enumeration of what is running on this machine, or
   * `undefined` when no cached engine exists to ask. Defaults to running the
   * cached binary the lifecycle verbs would pick. A throw is a hard failure and
   * passes through: an enumeration that could not run proves nothing about
   * liveness, so it must not read as gone.
   */
  listEngines?: () => Promise<readonly LocalEngine[] | undefined> | readonly LocalEngine[] | undefined;
  /**
   * Stop what a recorded engine that is no longer running left behind — the
   * helper processes a crashed engine does not take with it — returning the
   * pids stopped. Defaults to the real sweep, except for a caller that replaced
   * {@link listEngines} and not this: that caller (a test) has replaced the
   * machine, and the sweep would read past it.
   */
  sweepOrphans?: () => Promise<readonly number[]> | readonly number[];
  /**
   * Whether a not-running refusal ends with "`xanosdk deploy` still deploys to
   * an ephemeral". Right for a verb that USES an engine as a source; noise for
   * the `local` lifecycle verbs, which manage the engine itself. Default true.
   */
  deployFallback?: boolean;
  /**
   * Whether a Xano Engine's name was typed BARE — a lifecycle verb's
   * positional (`local token <name>`) — rather than as a
   * `local:<name>` selector. A near-name suggestion is spelled the way
   * the command takes it: the bare name would be refused by `tables`, the
   * selector by `local token`. Default false (a selector).
   */
  bareName?: boolean;
  /**
   * Who holds a gone tenant's or ephemeral's name as its DISPLAY name — the
   * list read behind "that is the display name of X". Defaults to the real
   * lookup, except for a caller that replaced the per-name lookups and not this
   * one: that caller (a test) has replaced the network, and the hint's list read
   * would reach past it.
   */
  displayNameOf?: (auth: ResolvedAuth, kind: DisplayNamedKind, name: string) => Promise<DisplayOwner | undefined>;
  /**
   * How that hint spells the fix. Defaults to the selector: `tenant:<name>`.
   * `typo` when the name typed does not address `name` for certain — a near
   * miss of a name or a display name, or one of several backends sharing the
   * display name typed. "Takes its name" misdescribes that, and the fix is a
   * guess: it asks before acting, never carrying the run's `--yes`.
   */
  displayNameFix?: (kind: DisplayNamedKind, name: string, typo?: boolean) => string;
  /** The closest tenant/ephemeral NAME to a gone one; read as `displayNameOf` is. */
  nearNameOf?: (
    auth: ResolvedAuth,
    kinds: readonly DisplayNamedKind[],
    name: string,
  ) => Promise<NearBackend | undefined>;
  /**
   * What a tenant with no workspace yet means to the caller. A tenant on its own
   * domain gets its workspace when its first release lands; until then every
   * per-workspace route there answers 404 "Invalid workspace".
   * - `read` (default): nothing to read — refused as not found (exit 8).
   * - `write`: refused as usage (exit 1) — land a release first.
   * - `any`: the caller handles it (`tenant deploy` lands the first release,
   *   `tenant get` reads the parent's record).
   */
  workspaceless?: "read" | "write" | "any";
  /**
   * Whether a tenant's host holds a workspace. Defaults to the real read,
   * except for a caller that replaced {@link getTenant} and not this: that
   * caller (a test) has replaced the network.
   */
  hasWorkspace?: (auth: ResolvedAuth, base: string) => Promise<boolean>;
  /** The workspace's release names, for a gone release's near-miss; read unless `findRelease` is replaced. */
  releaseNamesOf?: (auth: ResolvedAuth) => Promise<readonly string[]>;
}

/** A transport that failed to answer at all, as opposed to answering badly. */
export function isTransportFailure(err: unknown): boolean {
  if (err instanceof TransportError) return true;
  // A timeout arrives WRAPPED: `explainFetchFailure` returns a plain Error
  // whose `name` is "Error" and whose message says "did not answer", carrying
  // the DOMException as `cause`. Matching only the unwrapped name missed every
  // real timeout, so an instance that was merely slow reported as a hard
  // failure instead of unreachable — and unreachable is the one state whose
  // remedy is "do not create anything".
  if (isTimeoutError(err) || isTimeoutError((err as { cause?: unknown } | null)?.cause)) return true;
  if (!(err instanceof Error)) return false;
  return (
    /could not reach|did not answer|timed out|network|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(
      err.message,
    ) ||
    err.name === "TimeoutError" ||
    err.name === "AbortError"
  );
}

/**
 * A lookup the instance answered with a server error (5xx): no answer about the
 * backend either, so it is resolved as a transport failure is — exit 8 with the
 * rerun (E2E pass 28: a 502 exited 1, "get ephemeral failed (502)", no rerun).
 * Read from the error's `status` when the reader set one. A signature refusal
 * is a 500 that answers: the same archive is refused every time.
 */
export function isServerError(err: unknown): boolean {
  if (isSignatureRefusal(err)) return false;
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && ((status >= 500 && status < 600) || status === RATE_LIMITED);
}

/** The status of a request the instance's rate limit turned away: no answer yet, retried later. */
const RATE_LIMITED = 429;

/**
 * Whether the instance's rate limit (429) turned `err`'s request away: its
 * `status`, or a status failure's head (`<action> failed (429…`) for a write
 * transport that keeps only the sentence.
 */
export function isRateLimited(err: unknown): boolean {
  if ((err as { status?: unknown } | null)?.status === RATE_LIMITED) return true;
  const first = err instanceof Error ? (err.message.split("\n")[0] ?? "") : "";
  return /\bfailed \(429\b/.test(first);
}

/** `Rate limited`, with the wait the last 429's `Retry-After` asked for. */
export function rateLimitedCause(): string {
  const after = lastRateLimitRetryAfter();
  return `Rate limited${after === undefined ? "" : ` — retry after ${after}s`}`;
}

/**
 * Why a request got no answer, as the sentence opening its aftermath: a network
 * failure, a server error (5xx), or the instance's rate limit (429) with the
 * wait its `Retry-After` asked for.
 */
export function unansweredCause(err: unknown): string {
  // Before the transport test: a refused certificate is a TransportError too,
  // and calling it a network failure invites a retry that fails the same way.
  if (certificateFailureCode(err) !== undefined) return "A certificate problem";
  if (isTransportFailure(err)) return "A network failure";
  if (isRateLimited(err)) return rateLimitedCause();
  return "A server error";
}

/**
 * A request the instance's rate limit turned away (429) that reached the
 * dispatcher as a plain failure — a deploy's import, an ephemeral's create, an
 * env write. The limit is checked before a request is acted on, so nothing was
 * changed: no answer yet, as a read's 429 is — exit 8, the wait named, and the
 * dispatcher names this command line as the rerun. Lines below the failure's
 * head (what a first deploy created) are kept. Anything else passes through.
 */
export function rateLimitedFailure(err: unknown): unknown {
  if (!(err instanceof Error) || err instanceof SourceError || !isRateLimited(err)) return err;
  if ((err as { exitCode?: unknown }).exitCode !== undefined || (err as { code?: unknown }).code === "SDK_USAGE") return err;
  const [first = "", ...rest] = err.message.trim().split("\n");
  const failed = new LookupFailedError(
    `${first.trim().replace(/[.:]$/, "")}. ${rateLimitedCause()}: the instance turned this request away before acting ` +
      `on it, so it changed nothing`,
    "unreachable",
    "workspace",
    undefined,
    "Once the wait is over",
  );
  if (rest.length > 0) {
    failed.trailer = `\n${rest.join("\n")}`;
    failed.message += failed.trailer;
  }
  failed.cause = err;
  return failed;
}

/**
 * A READ-ONLY command's read that got no answer — a network failure or a
 * server error (5xx) — as the unreachable contract says it: exit 8, nothing
 * changed, and the dispatcher names this command line as the rerun. `what` is
 * the read, as a clause after "Could not" (`list the tests on ephemeral "x"`).
 * Anything else passes through as it is.
 */
export function unansweredRead(err: unknown, what: string, kind: SourceKind): unknown {
  if (err instanceof LookupFailedError) return err;
  const transport = isTransportFailure(err);
  if (!transport && !isServerError(err)) return err;
  const message = (err instanceof Error ? err.message : String(err)).trim();
  const head = (message.split("\n")[0] ?? message).trim().replace(/[.:]$/, "");
  const failed = new LookupFailedError(
    `Could not ${what} — ${head}. ${unansweredCause(err)} — nothing was changed`,
    "unreachable",
    kind,
  );
  // The transport's own error stays reachable: a host that does not resolve
  // under an environment credential is answered as the variable to fix.
  failed.cause = err;
  return failed;
}

/** Transport failure or server error: a lookup that got no answer about the backend. */
export function isUnansweredLookup(err: unknown): boolean {
  return isTransportFailure(err) || isServerError(err);
}

/** Clear this project's tracked record when it points at the env just found dead. */
function clearStale(auth: ResolvedAuth, name: string, cwd: string): boolean {
  const tracked = getEnvironment(readEphemeralState(cwd), auth);
  if (tracked?.name === name) return clearEnvironment(cwd, auth);
  return false;
}

function listHint(kind: SourceKind): string {
  switch (kind) {
    // With this run's credential flags: the list a bare command reads is the
    // machine default account's, not the one this run looked in.
    case "ephemeral":
      return `\`xanosdk ephemeral list${contextFlags()}\` shows the ones that exist`;
    // `tenant:<name>` reaches both kinds, and `tenant list` shows only the
    // standard ones — so a miss names both lists.
    case "tenant":
      return `\`xanosdk tenant list${contextFlags()}\` and \`xanosdk ephemeral list${contextFlags()}\` show the ones that exist`;
    case "release":
      return `\`xanosdk release list${contextFlags()}\` shows the ones that exist`;
    case "local":
      return "`xanosdk local list` shows the ones that are running";
    default:
      return "";
  }
}

function gone(kind: SourceKind, name: string): SourceError {
  // Named as the kind that was TYPED: `tenant:<name>` finds ephemerals too (one
  // IS a tenant on the wire), but "no tenant or ephemeral" answered a kind
  // nobody named. The list hint still names both lists.
  return new SourceError(`No ${kind} named "${name}". ${listHint(kind)}.`, "gone", kind);
}

/**
 * A lookup that got no answer, said as the run it ended: it exits 8 (not
 * found-or-unreachable) and the retry is THIS command once the backend answers.
 * "Retry." alone left which one unsaid. Its own class so the layer that knows
 * the command line — the dispatcher, from argv with secrets withheld, or the
 * backend slot, from its command path — can name the rerun with
 * {@link LookupFailedError.withRerun}; built here, below both, it says "this
 * command".
 */
export class LookupFailedError extends SourceError {
  /** Lines below the rerun sentence, carried into {@link withRerun}'s message. */
  trailer = "";

  constructor(
    /** Everything before the aftermath: what failed, and that nothing changed. */
    readonly head: string,
    liveness: Liveness,
    kind: SourceKind,
    rerun = "run this command again",
    /**
     * When the rerun is worth running, opening its sentence. A certificate the
     * handshake refused is not waited out, so for one it names the fix.
     */
    readonly when = head.includes(UNTRUSTED_CERTIFICATE) ? "Once the certificate is trusted" : "Once it is reachable",
  ) {
    super(`${head}, and this run exits 8. ${when}, ${rerun}.`, liveness, kind);
  }

  /** The same failure naming `command` (with `tail`, e.g. " as you ran it") as the rerun. */
  withRerun(command: string, tail = "", note = ""): LookupFailedError {
    const next = new LookupFailedError(this.head, this.liveness, this.kind, `run \`${command}\` again${tail}`, this.when);
    next.message += `${note}${this.trailer}`;
    next.trailer = this.trailer;
    return next;
  }
}

/**
 * The lookup itself never got an answer — a dropped connection, a reset, a
 * timeout. Nothing is known about the backend, so this must not read as "it
 * exists" any more than as "it is gone": it is a transient failure to retry.
 * Still `unreachable` (exit 8, whose documented next step is retry).
 */
export function lookupFailed(kind: SourceKind, name: string, err: unknown): LookupFailedError {
  // A transport failure already carries its aftermath on a line of its own
  // ("Nothing was changed — retry."): only its head is kept, so the lookup's
  // one aftermath sentence is the only one printed.
  const message = (err instanceof Error ? err.message : String(err)).trim();
  const head = err instanceof TransportError ? (message.split("\n")[0] ?? message) : message;
  const detail = head.trim().replace(/[.:]$/, "");
  return new LookupFailedError(
    `Could not look up ${kind} "${name}": ${detail}. ` +
      `${unansweredCause(err)}, not a missing ${kind} — nothing was created or changed`,
    "unreachable",
    kind,
  );
}

/**
 * The tracked (or named) ephemeral's lookup, as every command that starts from
 * one reads it: the summary, `null` when the platform says it is gone, and a
 * lookup that got no answer as {@link lookupFailed} — exit 8, "a network
 * failure, not a missing ephemeral — retry" — the same answer `deploy
 * ephemeral:<name>` gives. A plain transport error exited 1 with no aftermath.
 */
export async function lookupEphemeral(auth: ResolvedAuth, name: string): Promise<EphemeralSummary | null> {
  try {
    return await getEphemeral(auth, { parentWorkspaceId: auth.workspaceId, name });
  } catch (err) {
    if (isUnansweredLookup(err)) throw lookupFailed("ephemeral", name, err);
    throw err;
  }
}

function unreachable(kind: SourceKind, name: string, detail: string): SourceError {
  return new SourceError(
    `The ${kind} "${name}" exists but is not answering: ${detail} ` +
      `Nothing was created — retry, or check the instance.`,
    "unreachable",
    kind,
  );
}

/**
 * A gone tenant or ephemeral, told what it probably meant when the name given
 * is another one's DISPLAY name. See `display-name-hint.ts`.
 */
async function goneWithHint(
  err: SourceError,
  auth: ResolvedAuth,
  kind: DisplayNamedKind,
  name: string,
  deps: ResolveDeps,
): Promise<SourceError> {
  const replaced = kind === "tenant" ? deps.getTenant !== undefined : deps.getEphemeral !== undefined;
  const lookup = deps.displayNameOf ?? (replaced ? undefined : displayNameOwner);
  const spell = deps.displayNameFix ?? selectorFix;
  // An ephemeral IS a tenant on the wire, so `tenant:<name>` addresses one — but
  // the tenant list does not show it, so a tenant lookup asks both lists and a
  // display name a tenant and an ephemeral share reads as shared (E2E pass 53:
  // the tenant alone was answered, with a confirmed command for it). Each owner
  // is spelled as this verb or selector takes it.
  const kinds: readonly DisplayNamedKind[] = kind === "tenant" ? ["tenant", "ephemeral"] : [kind];
  const rows: DisplayOwnerRow[] = [];
  if (lookup !== undefined) {
    for (const k of kinds) rows.push(...ownerRows(k, await lookup(auth, k, name).catch(() => undefined)));
  }
  const fixKind = (row: DisplayOwnerRow): DisplayNamedKind => (kind === "tenant" ? "tenant" : row.kind);
  if (rows.length > 1) return sharedDisplayError(err, name, { owners: rows }, (row) => spell(fixKind(row), row.name, true));
  const only = rows[0];
  if (only !== undefined) {
    const fix = spell(fixKind(only), only.name);
    return new SourceError(`${err.message}\n${displayNameHint(only.kind, name, only.name, fix)}`, err.liveness, err.kind, only.name);
  }
  // A near-miss of a NAME (E2E pass 26: `tenant get tvem-lmwd-d7a6` exited 8
  // with no suggestion). Only where the lists are read for real, as above.
  const nearOf = deps.nearNameOf ?? (lookup === displayNameOwner ? nearBackendName : undefined);
  const near = nearOf === undefined ? undefined : await nearOf(auth, kind === "tenant" ? ["tenant", "ephemeral"] : [kind], name).catch(() => undefined);
  if (near === undefined) return err;
  // A near name or display name is a different backend from the one typed:
  // every fix is a guess, spelled as one (no `--yes`).
  const fix = (n: string): string => sentenceCase(spell(kind === "tenant" ? "tenant" : near.kind, n, true));
  return new SourceError(`${err.message}${nearBackendLines(near, fix)}`, err.liveness, err.kind, near.name, near.names);
}

/** A display-name lookup's answer as rows of `kind`: none, the one owner, or every owner it shares. */
function ownerRows(kind: DisplayNamedKind, owner: DisplayOwner | undefined): DisplayOwnerRow[] {
  if (owner === undefined) return [];
  return isShared(owner) ? [...owner.owners] : [{ kind, name: owner, detail: "" }];
}

/** A gone tenant or ephemeral whose name typed is the display name of several: every one named. */
function sharedDisplayError(err: SourceError, display: string, shared: SharedDisplay, fix: (row: DisplayOwnerRow) => string): SourceError {
  const names = shared.owners.map((o) => o.name);
  return new SourceError(`${err.message}\n${sharedDisplayHint(display, shared, fix)}`, err.liveness, err.kind, names[0], names);
}

/**
 * A gone release, with the closest name the release list holds (E2E pass 26:
 * `promote e2e26r-r9` exited 8 with no suggestion). Read only on the miss.
 */
async function releaseGone(auth: ResolvedAuth, name: string, deps: ResolveDeps): Promise<SourceError> {
  const err = gone("release", name);
  const namesOf = deps.releaseNamesOf ?? (deps.findRelease === undefined ? releaseNames : undefined);
  if (namesOf === undefined) return err;
  // Every name a tie names (E2E pass 27), the look-alike first — and it the `suggestion`.
  const near = suggestAll(name, (await namesOf(auth).catch(() => [])).filter((n) => n !== name));
  return near.length === 0 ? err : new SourceError(`${err.message}\nDid you mean ${orNamesNoted(name, near)}?`, err.liveness, err.kind, near[0], near);
}

/**
 * Refuse a resolved tenant whose host holds no workspace yet — for a caller
 * that resolved with `workspaceless: "any"` to run its own refusals first.
 */
export async function refuseWorkspaceless(
  resolved: ResolvedSource,
  mode: "read" | "write",
  hasWorkspace: (auth: ResolvedAuth, base: string) => Promise<boolean> = tenantHasWorkspace,
): Promise<void> {
  // `backend?.`: a hand-built resolution may carry none, and then there is nothing to ask.
  if (resolved.kind !== "tenant" || resolved.target.tenantType === "ephemeral" || resolved.backend?.kind !== "hosted") return;
  if (await hasWorkspace(resolved.backend.auth, resolved.target.base)) return;
  throw tenantNoWorkspace(resolved.target.env ?? resolved.target.label, resolved.target.display, mode);
}

/**
 * The refusal for a tenant with no workspace yet, addressed by a verb that
 * needs one. A read finds nothing (not found, exit 8 — and no retry, since
 * none can succeed before a landing); a write is refused as usage. Both name
 * the landing that creates the workspace.
 */
export function tenantNoWorkspace(tenant: string, display: string | undefined, mode: "read" | "write"): Error {
  const flags = contextFlags();
  const t = shellQuote(tenant);
  const shown = display !== undefined && display !== "" && display !== tenant ? ` (${JSON.stringify(display)})` : "";
  const named = `Tenant ${JSON.stringify(tenant)}${shown}`;
  const why = `a tenant on its own domain gets its workspace when its first release lands`;
  const land =
    `\`xanosdk tenant deploy ${t} <release>${pipedYes()}${flags}\` (\`xanosdk release list${flags}\` names them)`;
  if (mode === "read") {
    return new SourceError(
      `${named} has no workspace yet, so there is nothing to read: ${why}. Land one first: ${land}.`,
      "gone",
      "tenant",
    );
  }
  return new CliError(
    "SDK_USAGE",
    `${named} has no workspace yet, so there is nothing to write to: ${why}. Nothing was written.\n` +
      `Land a release on it first: ${land}, then run this again.`,
    { details: { reason: "tenant-has-no-workspace", tenant } },
  );
}

/** The names of this workspace's releases, for a near-miss. */
export async function releaseNames(auth: ResolvedAuth): Promise<string[]> {
  return (await listReleases(auth, { workspaceId: auth.workspaceId })).map((r) => r.name);
}

/**
 * Resolve a parsed source to a meta target and a backend, or throw a
 * {@link SourceError}.
 *
 * `credential` is awaited once for a hosted kind and never for a Xano Engine.
 *
 * `file` is not resolved here: it names bytes on disk, has no liveness, and
 * belongs to the caller that reads it.
 */
export async function resolveSource(
  source: Exclude<Source, { kind: "file" }>,
  credential: CredentialProvider,
  deps: ResolveDeps = {},
): Promise<ResolvedSource> {
  const cwd = deps.cwd ?? process.cwd();
  if (source.kind === "local") return resolveLocalEngine(source.name, cwd, deps);

  const auth = await credential();
  const hosted = await resolveHosted(auth, source, cwd, deps);
  return {
    ...hosted,
    backend: {
      kind: "hosted",
      auth,
      // An ephemeral and a tenant are each their own host, where workspace 1
      // never matches the credential's and so proves nothing about the binding.
      // A release is an object on the parent, addressed like the workspace.
      binding: bindingFor(auth, hosted.target.workspaceId, hosted.kind === "ephemeral" || hosted.kind === "tenant"),
    },
    bearer: auth,
  };
}

/** The hosted arms, which differ only in which lookup answers them. */
async function resolveHosted(
  auth: ResolvedAuth,
  source: Exclude<Source, { kind: "file" | "local" }>,
  cwd: string,
  deps: ResolveDeps,
): Promise<Omit<ResolvedSource, "backend" | "bearer">> {
  const get = deps.getEphemeral ?? getEphemeral;
  const tenant = deps.getTenant ?? getTenant;
  const release = deps.findRelease ?? findRelease;

  switch (source.kind) {
    case "workspace":
      // No network: the credential already says which workspace, on which
      // instance. There is nothing that could have been swept.
      return {
        kind: "workspace",
        provenance: "workspace",
        target: {
          base: auth.instance.replace(/\/$/, ""),
          workspaceId: auth.workspaceId,
          label: "your workspace",
        },
      };

    case "ephemeral": {
      const name = await resolveEphemeralName(auth, source.name, cwd);
      let summary;
      try {
        summary = await get(auth, { parentWorkspaceId: auth.workspaceId, name });
      } catch (err) {
        if (isUnansweredLookup(err)) {
          throw lookupFailed("ephemeral", name, err);
        }
        throw err;
      }
      if (summary === null) {
        const cleared = clearStale(auth, name, cwd);
        // The project's own ephemeral, deleted since: the remedy is the one a
        // later bare run gives once the record is gone, said the first time.
        if (cleared) {
          throw new SourceError(
            `No ephemeral named "${name}" — this project's ephemeral was deleted (cleared this project's record of it). ` +
              `Run \`xanosdk deploy --ephemeral${contextFlags()}\` to create a fresh one.`,
            "gone",
            "ephemeral",
          );
        }
        throw await goneWithHint(
          new SourceError(
            `No ephemeral named "${name}". ${listHint("ephemeral")}` +
              `${cleared ? " (cleared this project's record of it)" : ""}.`,
            "gone",
            "ephemeral",
          ),
          auth,
          "ephemeral",
          name,
          deps,
        );
      }
      if (isExpired(summary.expiresAt)) {
        const cleared = clearStale(auth, name, cwd);
        throw new SourceError(
          `Ephemeral "${name}" has expired. Run \`xanosdk deploy --ephemeral${contextFlags()}\` to create a fresh one` +
            `${cleared ? " (cleared this project's record of it)" : ""}.`,
          "expired",
          "ephemeral",
        );
      }
      if (summary.url === undefined) {
        throw unreachable("ephemeral", name, "it reports no URL.");
      }
      return {
        kind: "ephemeral",
        provenance: `ephemeral:${name}`,
        // An env's own internal workspace id is always 1, addressed at its own
        // base — which may carry a path prefix, so callers append to it.
        target: {
          base: summary.url.replace(/\/$/, ""),
          workspaceId: 1,
          label: name,
          env: name,
          ...(summary.display !== undefined ? { display: summary.display } : {}),
        },
      };
    }

    case "tenant": {
      let summary;
      try {
        summary = await tenant(auth, { workspaceId: auth.workspaceId, name: source.name });
      } catch (err) {
        if (isUnansweredLookup(err)) throw lookupFailed("tenant", source.name, err);
        throw err;
      }
      if (summary === null) throw await goneWithHint(gone("tenant", source.name), auth, "tenant", source.name, deps);
      // A tenant carries a state, and a tenant that is not serving is reachable
      // in the sense that the parent answered about it — and unusable, which is
      // what the caller needs to know.
      if (summary.state !== undefined && !/^(ok|active|ready|running)$/i.test(summary.state)) {
        throw unreachable("tenant", source.name, `its state is "${summary.state}".`);
      }
      if (summary.url === undefined) throw unreachable("tenant", source.name, "it reports no URL.");
      const tenantBase = summary.url.replace(/\/$/, "");
      const mode = deps.workspaceless ?? "read";
      const hasWorkspace = deps.hasWorkspace ?? (deps.getTenant === undefined ? tenantHasWorkspace : undefined);
      if (mode !== "any" && summary.type !== "ephemeral" && hasWorkspace !== undefined && !(await hasWorkspace(auth, tenantBase))) {
        throw tenantNoWorkspace(source.name, summary.display, mode);
      }
      return {
        kind: "tenant",
        provenance: `tenant:${source.name}`,
        target: {
          base: tenantBase,
          workspaceId: 1,
          label: source.name,
          env: source.name,
          tenantType: summary.type,
          ...(summary.display !== undefined ? { display: summary.display } : {}),
        },
      };
    }

    case "release": {
      let found;
      try {
        found = await release(auth, { workspaceId: auth.workspaceId, name: source.name });
      } catch (err) {
        if (isUnansweredLookup(err))
          throw lookupFailed("release", source.name, err);
        throw err;
      }
      if (found === null) throw await releaseGone(auth, source.name, deps);
      // Cut, but its bytes are not there. A different failure from never cut,
      // and a different fix: re-cut it rather than correct the name.
      if (!found.hasResource) {
        throw new SourceError(
          `Release "${source.name}" exists but its stored contents are missing. ` +
            `Cut it again from a live environment.`,
          "gone",
          "release",
        );
      }
      return {
        kind: "release",
        provenance: `release:${source.name}`,
        // A release is an object on the parent, not a place to send calls.
        target: {
          base: auth.instance.replace(/\/$/, ""),
          workspaceId: auth.workspaceId,
          label: source.name,
        },
        release: found,
      };
    }
  }
}

/**
 * The local arm: the engine named, else the one recorded for `cwd`, checked
 * against the enumeration.
 *
 * A recorded engine and a foreign one — which `local list` shows and
 * `stop` will stop — go through the same gate: matched by NAME against the
 * enumeration, then loopback-checked before the bearer is handed back. They
 * differ only in what a miss clears: a recorded name's rows, or nothing.
 *
 * The name comes first and needs no subprocess: bare `local` in a
 * project that never recorded one has nothing to look for.
 */
async function resolveLocalEngine(
  named: string | undefined,
  cwd: string,
  deps: ResolveDeps,
): Promise<ResolvedSource> {
  const env = deps.env ?? process.env;
  const name = named !== undefined && named !== "" ? named : getEngineRecord(cwd, env)?.name;
  if (name === undefined) {
    throw new SourceError(
      `No Xano Engine is recorded for this project, and no name was given.\n` +
        `Run \`xanosdk deploy --local\` to stand one up, or name one from ` +
        `\`xanosdk local list\`.` +
        (deps.deployFallback !== false ? ` Meanwhile \`xanosdk deploy --ephemeral${contextFlags()}\` still deploys to an ephemeral.` : ""),
      "gone",
      "local",
    );
  }

  const running = await (deps.listEngines ?? defaultEnumeration(env, cwd))();
  if (running === undefined) {
    // Not proof the engine is dead — only that nothing on this machine can ask.
    // So the record stays: it is still the best hint there is.
    throw new SourceError(
      `No engine is cached on this machine, so nothing here can find "${name}".\n` +
        `Run \`xanosdk deploy --local\` to fetch one.` +
        (deps.deployFallback !== false ? ` Meanwhile \`xanosdk deploy --ephemeral${contextFlags()}\` still deploys to an ephemeral.` : ""),
      "gone",
      "local",
    );
  }

  // A recorded engine the enumeration no longer lists died without stopping
  // what it started (E2E pass 26: a `kill -9` left its data process serving
  // with no listing to find it). Swept here, where the record is found stale —
  // the refusal below says what it stopped beside the record it cleared.
  const stale = !running.some((e) => e.name === name) && listEngineRecords(env).some((r) => r.name === name);
  const sweep = deps.sweepOrphans ?? (deps.listEngines === undefined ? defaultSweep(env) : undefined);
  const swept = stale && sweep !== undefined ? await sweep() : [];
  const engine = liveEngine(name, running, env, deps.deployFallback !== false, swept, deps.bareName === true);
  return {
    kind: "local",
    provenance: named !== undefined && named !== "" ? `local:${name}` : "local",
    target: {
      base: engine.url.replace(/\/$/, ""),
      workspaceId: engine.workspaceId,
      label: named !== undefined && named !== "" ? name : "your Xano Engine",
    },
    backend: { kind: "local", engine },
    // The ENUMERATION's url and token, never a record's: a restarted engine
    // binds a fresh port and re-mints its bearer.
    bearer: { access_token: engine.token, instance: engine.url },
  };
}

/** The named engine live, or the {@link SourceError} for the state it is actually in. */
function liveEngine(
  name: string,
  running: readonly LocalEngine[],
  env: NodeJS.ProcessEnv,
  deployFallback: boolean,
  swept: readonly number[] = [],
  bareName = false,
): LocalEngine {
  const recorded = listEngineRecords(env).some((r) => r.name === name);
  const engine = running.find((e) => e.name === name);
  if (engine === undefined) {
    // Stale: the record is a hint to an engine that is not there, and leaving
    // it would keep a dead engine findable. Cleared before the refusal, which
    // then says so. Name-keyed, like `stop`: no row anywhere may keep claiming
    // it. A name no record holds clears nothing. A near name is spelled the
    // way this command takes it — `local:<name>` from a selector.
    const near = suggest(name, running.map((e) => e.name));
    throw engineNotRunning(
      name,
      recorded ? clearEngineRecordsNamed(name, env).length : 0,
      deployFallback,
      near === undefined || bareName ? near : `local:${near}`,
      swept,
    );
  }
  try {
    assertLoopbackUrl(
      engine.url,
      recorded ? "The engine recorded for this project" : `The engine named "${name}"`,
    );
  } catch (err) {
    // Running, and not somewhere its bearer may follow. Nothing is cleared:
    // the record is accurate, and the fix is to restart the engine bound to
    // loopback, not to forget it.
    throw new SourceError((err as Error).message, "unreachable", "local");
  }
  return engine;
}

/**
 * The three beats for an engine that is not running: cause, fix, what still works.
 *
 * For the verbs that resolve an engine to USE it. `local stop <name>` of
 * one that is not running does not come here: the engine is already where the
 * stop would leave it, so it exits 0 with `alreadyStopped: true`.
 */
function engineNotRunning(
  name: string,
  clearedProjects: number,
  deployFallback = true,
  nearest?: string,
  swept: readonly number[] = [],
): SourceError {
  const said = [
    ...(clearedProjects === 0
      ? []
      : [clearedProjects === 1 ? "cleared its local record" : `cleared its record in ${clearedProjects} projects`]),
    ...(swept.length === 0
      ? []
      : [`stopped ${swept.length === 1 ? "a process" : `${swept.length} processes`} it left running (pid ${swept.join(", ")})`]),
  ];
  const tail = said.length === 0 ? "" : ` (${said.join("; ")})`;
  return new SourceError(
    `Xano Engine "${name}" is not running${tail}.\n` +
      // A one-letter slip on a name nobody types by hand — say which one runs.
      (nearest !== undefined ? `Did you mean \`${nearest}\`? It is running.\n` : "") +
      `${listHint("local")}, and \`xanosdk deploy --local\` stands one up.` +
      (deployFallback ? ` Meanwhile \`xanosdk deploy --ephemeral${contextFlags()}\` still deploys to an ephemeral.` : ""),
    "gone",
    "local",
    nearest,
  );
}

/** The real sweep, imported lazily for the same reason as {@link defaultEnumeration}. */
function defaultSweep(env: NodeJS.ProcessEnv): () => Promise<readonly number[]> {
  return async () => {
    const { stopOrphanedEngineProcesses } = await import("../deploy/local-engine-process.js");
    return stopOrphanedEngineProcesses({ env }).stopped;
  };
}

/**
 * The enumeration through the cached binary the lifecycle verbs pick.
 *
 * Imported lazily: it is the one path here that runs a subprocess, and the
 * hosted kinds — most resolves — never need it loaded.
 */
function defaultEnumeration(
  env: NodeJS.ProcessEnv,
  cwd: string,
): () => Promise<readonly LocalEngine[] | undefined> {
  return async () => {
    const { cachedEngineEntry, listEngines } = await import("../deploy/local-engine-process.js");
    const entry = cachedEngineEntry(env, cwd);
    return entry === undefined ? undefined : listEngines({ entry, env });
  };
}
