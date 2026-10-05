/**
 * Node-only transport for `POST workspace/{workspace_id}/xanosdk/import` — the
 * ONLY route the SDK imports through. `release` previews and applies here,
 * `deploy --keep-data` merges here, and a replacing `deploy` (ephemeral or local
 * engine) and `preflight`'s disposable environment send `mode=replace` here.
 * There is no fallback to any other route.
 *
 * ## Why not the general-purpose import
 *
 * The instance's general-purpose `workspace/{workspace_id}/import` route was
 * built for backup restore and workspace transfer, and it resolves two kinds of collision by INVENTING an
 * identity, silently, while still answering 200:
 *
 *  • A name collision with a different-guid object of the same kind becomes
 *    `<name>_01`. Release a table named `user` into a workspace that already
 *    holds a different `user` and you get a second table plus sixty endpoints
 *    bound to the wrong one, reported as success.
 *  • A public URL slug (`canonical`) is unique per INSTANCE, not per workspace.
 *    On insert the import mints a random token when another workspace owns the
 *    slug, and on update it keeps the stored one and discards the archive's.
 *    Every frontend route derived from the slug pinned in code then 404s, and
 *    the release still reports success.
 *
 * Both are correct for restore and transfer and wrong for a code deploy, where
 * the archive's identities ARE the contract. This route refuses and NAMES the
 * conflict instead, and this module is the client half of that contract.
 *
 * ## The posture: fail closed on every signal that could be inferred
 *
 * Every check here exists because its absence is indistinguishable from
 * success:
 *
 *  • The decoder refuses a response missing any gated field as firmly as it
 *    refuses a wrong one. A server that does not say which branch it planned
 *    against is indistinguishable, from here, from one that ignored the
 *    parameter — which would import into live and report success.
 *  • A refusal is a non-2xx carrying a structured payload. A 200 with
 *    `applied: false` would let a naive caller read a refusal as success, so a
 *    200 whose `applied` disagrees with what was asked is itself refused.
 *
 * ## Retries key on `dry_run`
 *
 * Preview and write are the same route and the same code path; the field is
 * what separates them. A dry run changes nothing, so a dropped connection is
 * safe to retry. A write is NOT — it is not atomic from here, it can fail after
 * the point of no return, and a retry would apply it twice.
 *
 * The URL is built by string concatenation (not `new URL(path, base)`) so a
 * self-hosted base URL carrying a `/tenant/{name}` path prefix is preserved
 * rather than discarded — the same rule the other transports follow.
 */
import type { BearerTarget } from "../auth/token.js";
import {
  closeSentence,
  certificateFailureCode,
  describeTransportFailure,
  explainBodyFailure,
  debugEnabled,
  isTimeoutError,
  lostAnswerHead,
  notJsonError,
  noteRateLimit,
  serverMessage,
  statusLabel,
  transportTarget,
  TransportError,
  writeStatusAftermath,
} from "../util/http.js";
import { ImportHttpError } from "./import.js";
import { noteMetaAnswer } from "../util/last-credential.js";
import { describeWrite } from "../util/sent-writes.js";
import type { ImportMode, MergeOptions } from "./import.js";
import { readArchiveEntries } from "../validate/archive.js";
import { calcSignatureJson, signatureHolds } from "../workspace/export.js";
import { tarGz, type TarFile } from "../util/tar.js";
import { HOSTED_FILE_SCHEME, HOSTED_ICON_KINDS, HOSTED_ROW_PATH_PREFIX } from "../fields/hosted-file.js";

/** One planned change from a dry run. Mirrors the server's `operations[]` entries. */
export interface ImportOperation {
  /** Object kind as the server names it (`function`, `dbo`, `query`, …). */
  type: string;
  name: string;
  /** `create` | `update` | `delete` | `truncate` | … — the server owns this vocabulary. */
  action: string;
  details?: string;
  /** Present when the server wants to explain an entry — notably row loss. */
  reason?: string;
}

/** The parsed plan a dry run returns. Counts live in `summary`; `operations` is the detail. */
export interface ImportPlan {
  workspaceName: string | undefined;
  /**
   * Per-action and per-type counts, plus any `notes` the server attaches —
   * those as the CLI can show them, never the instance's prose verbatim.
   */
  summary: Record<string, unknown>;
  /** True only when rows will actually be written — the archive must carry them. */
  hasRecords: boolean;
  hasEnv: boolean;
  operations: ImportOperation[];
  /** The branch the server says this plan targets, when it says. */
  branch: string | undefined;
}

/** The archive upload bound, so a stalled import can't hang CI. */
const IMPORT_TIMEOUT_MS = 120_000;

/** The capability probe uploads nothing, so it gets a far tighter bound. */
const PROBE_TIMEOUT_MS = 15_000;

/** Attempts for a call that writes nothing. A write gets exactly one, always. */
const READ_ATTEMPTS = 3;
/** Backoff between read attempts. Doubles each time: 400ms, then 800ms. */
const READ_BACKOFF_MS = 400;

/**
 * The code family the route refuses under.
 *
 * The route reports WHICH refusal it is in the exception payload's `reason`,
 * not in the response envelope's top-level `code`. That code is the generic
 * bad-request one for every refusal the route can raise, so it cannot tell them
 * apart and matching on it would treat all three as the same failure.
 *
 * Recognition is therefore the PRESENCE of a payload `reason`, not a fixed set
 * of values: a reason added to the route later still decodes as a refusal —
 * with its conflicts and the server's own sentence — instead of degrading into
 * an anonymous HTTP failure. The three below are the ones this module attaches
 * meaning to.
 */

/** A conflict (name or canonical) was found; nothing was written. */
export const XANOSDK_IMPORT_CONFLICT_CODE = "conflict";

/**
 * Another import holds the instance-wide lock. The only refusal here that is
 * worth retrying unchanged — everything else needs the project to change first.
 */
export const XANOSDK_IMPORT_IN_PROGRESS_CODE = "import_in_progress";

/**
 * A uniqueness constraint rejected a write that the pre-flight let through.
 * Reported as itself rather than as a lock problem: it means the pre-flight and
 * the database disagree, which is a defect to report, not a race to retry.
 */
export const XANOSDK_IMPORT_UNIQUENESS_CODE = "uniqueness_violation";

/**
 * The payload `reason` of a refusal for a field that points at a hosted file
 * (`hostedFile(...)`) the archive does not carry. Nothing was written.
 */
export const XANOSDK_IMPORT_UNRESOLVED_FILE_CODE = "unresolved_hosted_file";

/** What the route did with one object's public URL slug. */
export type CanonicalOutcome =
  /** The requested slug was free (or already ours) and is now served. */
  | "honored"
  /** An update left the stored slug in place; the requested one was a preference, not a pin. */
  | "kept"
  /** A create found the slug taken, so the instance minted a random token instead. */
  | "minted"
  /** A PINNED slug is owned elsewhere. Refuses the import rather than inventing a URL. */
  | "conflict";

const CANONICAL_OUTCOMES: readonly CanonicalOutcome[] = ["honored", "kept", "minted", "conflict"];

/**
 * Who already holds the identity the archive wants.
 *
 * The owning WORKSPACE is the load-bearing part: when it is not the one being
 * released into, no remedy in the caller's project applies — the fix is in
 * another workspace, and the release command prints a different instruction for
 * that case.
 */
export interface XanoSdkImportConflictOwner {
  /** The workspace holding the colliding object. */
  workspaceId: number;
  /** Its human name, when the server supplies one. */
  workspaceName: string | undefined;
  /** The colliding object's guid — the value to pin in the lock to adopt it. */
  guid: string | undefined;
  /** The branch the colliding object lives on. */
  branch: string | undefined;
  /** True for a soft-deleted owner. It still holds the identity, which is why it is reported. */
  deleted: boolean;
}

/** One identity the archive cannot take, with the object that already has it. */
export interface XanoSdkImportConflict {
  /** Object kind as the server names it (`dbo`, `query`, `api`, …). */
  kind: string;
  /** The composed identity that collided — a name, or a `group + verb + name` style key. */
  identity: string;
  /** The guid the archive carries for the object it wanted to write. */
  archiveGuid: string | undefined;
  owner: XanoSdkImportConflictOwner;
}

/** What one canonical-bearing object asked for and what it actually serves. */
export interface XanoSdkCanonicalReport {
  /** `api`, `toolset`, `realtime` — the server's vocabulary. */
  kind: string;
  name: string;
  guid: string | undefined;
  /** The slug the archive carried. */
  requested: string | undefined;
  /** The slug now served. Differs from `requested` for `kept` and `minted`. */
  served: string | undefined;
  outcome: CanonicalOutcome;
}

/** The plan half of the response — what the import would do, or did. */
export interface XanoSdkImportPlan {
  /** Per-action and per-type counts, plus any `notes` the server attaches. */
  summary: Record<string, unknown>;
  operations: ImportOperation[];
  /** True only when rows will actually be written — the archive must carry them. */
  hasRecords: boolean;
  hasEnv: boolean;
}

/** The decoded 200 from the route. Every field here was verified present, not defaulted. */
export interface XanoSdkImportResponse {
  workspace: { id: number | undefined; name: string | undefined };
  /**
   * The branch the route planned against — always present, and the LIVE label
   * when the caller sent none. This is the SDK's only positive evidence that a
   * `branch` request was understood rather than discarded.
   */
  branch: string;
  /** False for a dry run. Checked against what was asked, never trusted alone. */
  applied: boolean;
  plan: XanoSdkImportPlan;
  /** Empty on an applied import: a conflict there is a refusal, not a 200. */
  conflicts: XanoSdkImportConflict[];
  canonicals: XanoSdkCanonicalReport[];
  /**
   * How many `hostedFile(...)` references the route resolved to the
   * destination's own address. Present whenever the archive carried any, and
   * then equal to that count — {@link xanosdkImport} refuses anything less.
   */
  hostedFiles?: { resolved: number; unresolved: number };
  /** Raw response body, kept for diagnostics. */
  raw: string;
}

/**
 * An import whose connection never opened (refused, DNS miss): nothing was
 * sent, so nothing — the clear a replace opens with included — ran. Typed so a
 * caller that would otherwise ask what a failed replace left standing knows
 * there is nothing to ask about.
 */
export class ImportNotSentError extends TransportError {}

/**
 * A refusal: the route declined and wrote nothing.
 *
 * Distinct from a transport or HTTP failure because it is the route working as
 * designed — the conflict list on it is the ANSWER, not debris, and the release
 * command renders it with per-conflict remedies. Recognized by the payload's
 * machine-readable `reason` rather than by parsing prose.
 */
export class XanoSdkImportRefusal extends Error {
  constructor(
    readonly status: number,
    /**
     * The payload's machine-readable discriminator, e.g.
     * {@link XANOSDK_IMPORT_CONFLICT_CODE}. NOT the response envelope's code,
     * which is the same generic value for every refusal.
     */
    readonly code: string,
    /** The server's own sentence for why. */
    readonly reason: string,
    readonly conflicts: XanoSdkImportConflict[],
    readonly canonicals: XanoSdkCanonicalReport[],
    /** Raw response body, kept for diagnostics. */
    readonly raw: string,
    message: string,
  ) {
    super(message);
    this.name = "XanoSdkImportRefusal";
  }

  /**
   * True only for the in-progress refusal — a second caller that lost the race
   * for the instance-wide lock. Every other refusal names something the project
   * has to change, so retrying it unchanged would just refuse again.
   */
  get retryable(): boolean {
    return this.code === XANOSDK_IMPORT_IN_PROGRESS_CODE;
  }
}

/** Where to send the request, and what the caller may inject for tests. */
export interface XanoSdkImportTarget {
  baseUrl: string;
  /**
   * The real workspace id. No default: this route only ever targets a workspace
   * someone owns, and defaulting it to the ephemeral `1` would point a release
   * at the wrong place on a typo.
   */
  workspaceId: number;
  /**
   * How user output names the destination (`ephemeral "e4f2-…" ("My App")`),
   * beside its host in a transport failure. Optional: without it the host
   * alone is named. Never the route — see {@link transportTarget}.
   */
  label?: string;
  /**
   * How the reader sees what the target holds now, as a whole sentence — said
   * after a MERGE write whose outcome is unknown, where the next step depends
   * on whether it landed. The caller knows the command that answers it: `--to`
   * has a `--dry-run` to preview again, an ephemeral has none and is looked at
   * with `xanosdk tables ephemeral:<name>`. Without it nothing is advised — a
   * sentence naming no command is not one the reader can act on.
   */
  stateCheck?: string;
  /** Injected transport. Defaults to the global `fetch`; tests supply a fake so nothing hits the network. */
  fetchFn?: typeof fetch;
  /** Injected backoff, for the same reason. */
  sleep?: (ms: number) => Promise<void>;
}

/** Everything one call to the route carries. */
export interface XanoSdkImportRequest extends XanoSdkImportTarget, MergeOptions {
  archive: Uint8Array;
  /**
   * Preview (`true`) or write (`false`). Always sent explicitly — a field that
   * decides whether anything is written is never left to a server-side default.
   * It is also what decides whether a failed call may be retried.
   */
  dryRun: boolean;
  mode?: ImportMode;
  /** Land on this branch instead of whichever one is live. The route creates it. */
  branch?: string;
  /**
   * Guids whose canonical is PINNED IN CODE, and so is a contract the route
   * must serve or refuse. Every other canonical in the archive is a preference
   * the route may keep or mint. Only the SDK knows which is which, which is why
   * it rides the request.
   */
  pinned?: readonly string[];
  /**
   * Store the guid each archive object carries instead of letting the route
   * mint a fresh one. `mode=replace` only — a merge already preserves the
   * archive's guids by matching rows on them, so the route answers "no" to this
   * flag under merge and it is inert there.
   *
   * This is what makes a redeploy UPDATE the objects a previous release created
   * rather than create a second copy of each: the SDK derives guids
   * deterministically (`md5(payloadKey:name)`, frozen in `xano.lock`), so a
   * preserved guid is one the next release will send again and the route will
   * match. Without it, every replace hands back a workspace whose identities no
   * longer correspond to anything the project holds.
   *
   * Omitted sends no parameter and the route defaults to `false`, which is the
   * historical behaviour. Sent as `true`, the route additionally REFUSES an
   * archive in which two objects of one type share a guid, or a guid is
   * malformed — that refusal is a plain 400 carrying the engine's sentence, not
   * one of the structured `reason` refusals {@link XanoSdkImportRefusal}
   * decodes, so it surfaces as an {@link ImportHttpError}.
   */
  preserveGuids?: boolean;
}

/**
 * `{baseUrl}/api:meta/workspace/{id}/xanosdk/import{qs}`.
 *
 * Concatenated, never resolved — see the module header: a self-hosted base URL
 * may carry a `/tenant/{name}` prefix that `new URL(path, base)` drops.
 */
function endpoint(target: { baseUrl: string; workspaceId: number }, qs = ""): string {
  return `${target.baseUrl.replace(/\/$/, "")}/api:meta/workspace/${target.workspaceId}/xanosdk/import${qs}`;
}

/**
 * The query string for a request.
 *
 * `dry_run`, `branch` and `pinned[]` ride here rather than in the body so the
 * multipart body is the plain archive upload and nothing else — the part of the
 * request that is expensive to build and hard to inspect carries no options.
 *
 * `prune` is the SDK's name for it; the route calls it `delete`.
 */
function query(opts: XanoSdkImportRequest): string {
  const params = new URLSearchParams();
  if (opts.mode !== undefined) params.set("mode", opts.mode);
  if (opts.prune !== undefined) params.set("delete", String(opts.prune));
  if (opts.records !== undefined) params.set("records", String(opts.records));
  if (opts.truncate !== undefined) params.set("truncate", String(opts.truncate));
  if (opts.branch !== undefined) params.set("branch", opts.branch);
  if (opts.preserveGuids !== undefined) params.set("preserve_guids", String(opts.preserveGuids));
  params.set("dry_run", String(opts.dryRun));
  // Repeated `pinned[]=…`, which is how the route's list input is spelled on
  // the wire. An empty list appends nothing, which is the same request a caller
  // with no code-pinned canonicals makes.
  for (const guid of opts.pinned ?? []) params.append("pinned[]", guid);
  return `?${params.toString()}`;
}

/** The archive as a multipart body. Rebuilt per call so a retry can't reuse a consumed stream. */
function body(archive: Uint8Array): FormData {
  const form = new FormData();
  // Copy into a fresh ArrayBuffer-backed Blob so the multipart body is exact.
  // The filename must NOT end in `.enc.gz` — the server reads that as encrypted
  // and demands a password; a plain `.gz` imports unencrypted.
  form.append("file", new Blob([archive], { type: "application/gzip" }), "workspace.gz");
  return form;
}

/**
 * Detection results for this PROCESS, keyed by base URL.
 *
 * Nothing is cached on disk: a disk cache would outlive the instance upgrade
 * that changes the answer. Keyed by base URL rather than by workspace, because
 * the route either exists on an instance or does not. The promise is memoized
 * so concurrent callers make one probe, and REMOVED on rejection so a transient
 * failure does not poison the process.
 */
const detectionByBaseUrl = new Map<string, Promise<boolean>>();

/** Same normalization the endpoint builder applies, so two spellings of one instance share a result. */
function detectionKey(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

/**
 * Forget memoized detection results. Tests only — a process has no reason to
 * ask twice, and an instance does not gain the route mid-run.
 */
export function resetXanoSdkImportDetection(baseUrl?: string): void {
  if (baseUrl === undefined) detectionByBaseUrl.clear();
  else detectionByBaseUrl.delete(detectionKey(baseUrl));
}

/**
 * An instance that answered something that is neither support nor its absence.
 * `status` is the probe's HTTP status when it answered one — a caller reads a
 * server error (5xx) as a check that got no answer, as a transport failure is.
 */
function undecidable(baseUrl: string, why: string, status?: number): Error {
  const err = new Error(
    `Could not determine whether this instance supports a merging deploy: ${why}\n` +
      `  instance: ${baseUrl}\n` +
      `Only a 404 means the route is absent. Every other answer leaves the question open, and ` +
      `guessing either way would decide how this deploy writes on no evidence.\n` +
      `Nothing was deployed — fix the access or reachability problem, then retry the deploy.`,
  );
  if (status !== undefined) Object.defineProperty(err, "status", { value: status, enumerable: false });
  return err;
}

/**
 * Can this target merge? Probed once per base URL per process.
 *
 * A deploy that keeps data merges through this route and nowhere else, because
 * the general-purpose route resolves a collision by inventing a name and
 * answering 200. So the route's presence IS the capability, and it is asked
 * before an archive is built for it.
 *
 * The probe is a bodyless POST: the route rejects it during input binding,
 * before it reads an archive or touches the workspace, which makes it both free
 * and side-effect free. `dry_run=true` rides along so that even a backend
 * tolerant of a missing file cannot be made to write by a capability check.
 *
 * - `404` → absent.
 * - `400` / `422` (or a `2xx`, for a backend that tolerates the empty probe)
 *   → present.
 * - `401` / `403`, `5xx`, unreachable → THROWS. An instance that will not talk
 *   to us is not evidence that a route is missing.
 *
 * Takes a {@link BearerTarget}: the probe reads nothing but the bearer, and a
 * Xano Engine has nothing else to hand over.
 */
export async function detectXanoSdkImportRoute(auth: BearerTarget, target: XanoSdkImportTarget): Promise<boolean> {
  const key = detectionKey(target.baseUrl);
  const cached = detectionByBaseUrl.get(key);
  if (cached !== undefined) return cached;

  const probe = probeXanoSdkImportRoute(auth, target);
  detectionByBaseUrl.set(key, probe);
  // Drop a rejected probe so a transient failure is not remembered as the
  // answer for the rest of the process.
  probe.catch(() => detectionByBaseUrl.delete(key));
  return probe;
}

async function probeXanoSdkImportRoute(auth: BearerTarget, target: XanoSdkImportTarget): Promise<boolean> {
  const fetchFn = target.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(endpoint(target, "?dry_run=true"), {
      method: "POST",
      headers: { accept: "application/json", Authorization: `Bearer ${auth.access_token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await noteMetaAnswer(endpoint(target, ""), res);
    noteRateLimit(res);
  } catch (err) {
    throw undecidable(target.baseUrl, `could not reach it (${describeTransportFailure(err)}).`);
  }

  if (res.status === 404) return false;
  if (res.ok || res.status === 400 || res.status === 422) return true;

  const text = await res.text().catch(() => "");
  const detail = serverMessage(text);
  throw undecidable(
    target.baseUrl,
    // `statusLabel`: an empty statusText left "answered 503 : injected" (E2E pass 28).
    `the probe answered ${statusLabel(res)}${detail !== undefined ? `: ${detail}` : "."}`,
    res.status,
  );
}

/** Everything below decodes the response, and refuses rather than repairs. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A gated field is missing or the wrong shape.
 *
 * The field is NAMED, because the reader's next question is which half of the
 * contract broke — an instance that predates a field, or a decoder that is
 * behind the instance — and the field name is the only thing that answers it.
 */
function malformed(field: string, why: string, ctx: DecodeContext): Error {
  const target = ctx.target;
  const Target = target.charAt(0).toUpperCase() + target.slice(1);
  const detail = `(no usable \`${field}\`: ${why})`;
  const head =
    ctx.answer === "refusal"
      ? `${Target} refused the ${ctx.verb} with a detail that could not be read ${detail}.`
      : ctx.answer === "preview"
        ? `${Target} answered the ${ctx.verb} with something that isn't a preview result ${detail}. ` +
          `A dry run writes nothing, so ${target} is untouched.`
        : `${Target} answered the ${ctx.verb} with something that isn't a ${ctx.verb} result ${detail} — ` +
          `it may or may not have landed; check ${target} before retrying.`;
  // Never the body: a real workspace's or tenant's answer can carry anything.
  // `XANOSDK_DEBUG` has it for whoever is diagnosing the instance.
  return new Error(debugEnabled() && ctx.raw.trim() !== "" ? `${head}\n${ctx.raw}` : head);
}

/**
 * What a decode failure says about a value it could not use: its KIND, never
 * its contents — a string or an object off the wire is part of the body.
 */
function kindOf(value: unknown): string {
  if (value === undefined) return "the field is not present";
  if (value === null) return "got null";
  if (typeof value === "boolean") return `got ${value}`;
  if (Array.isArray(value)) return "got a list";
  if (typeof value === "object") return "got an object";
  return `got a ${typeof value}`;
}

/** Who is decoding, so a refusal names the target and the call as the reader knows them. */
interface DecodeContext {
  /** The body, for `XANOSDK_DEBUG` only. */
  raw: string;
  /** How the target is named (`ephemeral "e4f2-…"`, `tenant "eu"`), or "the target". */
  target: string;
  /** `deploy` for the transport's own callers; what the reader ran. */
  verb: string;
  /** Which answer is being read — decides what the failure says about the target. */
  answer: "write" | "preview" | "refusal";
}

function requiredString(value: unknown, field: string, raw: DecodeContext): string {
  // An empty string is treated as ABSENT, not as a value: it is what a server
  // emits for a field it computed nothing for, and accepting it would let a
  // release "confirm" a branch nobody can address.
  if (typeof value !== "string" || value === "") {
    throw malformed(field, kindOf(value), raw);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function decodeConflict(entry: unknown, index: number, raw: DecodeContext): XanoSdkImportConflict {
  const field = `conflicts[${index}]`;
  if (!isRecord(entry)) throw malformed(field, kindOf(entry), raw);

  const owner = entry.owner;
  // The owner decides which remedy applies — rename here, adopt the guid, or go
  // fix another workspace — so a conflict without one is not a usable conflict.
  if (!isRecord(owner)) throw malformed(`${field}.owner`, "a conflict must name the object that already holds the identity", raw);
  const workspaceId = owner.workspace_id;
  if (typeof workspaceId !== "number") {
    throw malformed(`${field}.owner.workspace_id`, kindOf(workspaceId), raw);
  }

  return {
    kind: requiredString(entry.kind, `${field}.kind`, raw),
    identity: requiredString(entry.identity, `${field}.identity`, raw),
    archiveGuid: optionalString(entry.archive_guid),
    owner: {
      workspaceId,
      // The descriptive half degrades to "unknown" without changing any
      // decision, so it is read liberally: which workspace owns it is the fact
      // the remedy turns on, and that one is checked above.
      workspaceName: optionalString(owner.workspace_name),
      guid: optionalString(owner.guid),
      branch: optionalString(owner.branch),
      deleted: owner.deleted === true,
    },
  };
}

function decodeCanonical(entry: unknown, index: number, raw: DecodeContext): XanoSdkCanonicalReport {
  const field = `canonicals[${index}]`;
  if (!isRecord(entry)) throw malformed(field, kindOf(entry), raw);

  // `outcome` is a CLOSED SET, and it is checked rather than cast — a union is a
  // compile-time construct and this value comes off the wire. Rejected, never
  // normalized: an outcome this decoder does not know is one whose consequence
  // for a public URL it also does not know, and quietly filing it under
  // `honored` is the one wrong answer.
  const outcome = entry.outcome;
  if (typeof outcome !== "string" || !(CANONICAL_OUTCOMES as readonly string[]).includes(outcome)) {
    throw malformed(
      `${field}.outcome`,
      `${kindOf(outcome)}${typeof outcome === "string" ? " this CLI does not know" : ""}, expected one of ${CANONICAL_OUTCOMES.map((o) => JSON.stringify(o)).join(", ")}`,
      raw,
    );
  }

  return {
    kind: requiredString(entry.kind, `${field}.kind`, raw),
    name: requiredString(entry.name, `${field}.name`, raw),
    guid: optionalString(entry.guid),
    requested: optionalString(entry.requested),
    served: optionalString(entry.served),
    outcome: outcome as CanonicalOutcome,
  };
}

function decodePlan(value: unknown, raw: DecodeContext): XanoSdkImportPlan {
  if (!isRecord(value)) throw malformed("plan", kindOf(value), raw);
  if (!isRecord(value.summary)) throw malformed("plan.summary", kindOf(value.summary), raw);
  if (!Array.isArray(value.operations)) {
    throw malformed("plan.operations", kindOf(value.operations), raw);
  }

  const operations: ImportOperation[] = value.operations.map((entry) => {
    const op = isRecord(entry) ? entry : {};
    return {
      type: typeof op.type === "string" ? op.type : "",
      name: typeof op.name === "string" ? op.name : "",
      action: typeof op.action === "string" ? op.action : "",
      ...(typeof op.details === "string" ? { details: op.details } : {}),
      ...(typeof op.reason === "string" ? { reason: op.reason } : {}),
    };
  });

  return {
    summary: value.summary,
    operations,
    hasRecords: value.has_records === true,
    hasEnv: value.has_env === true,
  };
}

/**
 * Decode a 200. Every gated field is verified present before anything is returned.
 *
 * A 200 that is not JSON names the host, never the route or the body (a proxy's
 * page), and — for a write — says what is and is not known about it: the
 * request was answered, but not by anything that says whether it applied.
 */
function decodeResponse(
  text: string,
  dryRun: boolean,
  where: { action: string; baseUrl: string; label?: string },
): XanoSdkImportResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const head = notJsonError(where.action, text, where.baseUrl).message;
    const target = where.label ?? "the target";
    throw new Error(
      `${head}\n` +
        (dryRun
          ? `A dry run writes nothing, so ${target} is untouched.`
          : `Whether the import ran cannot be read from that answer — it may or may not have landed, in ` +
            `whole or in part. Check ${target} before retrying.`),
    );
  }
  const raw: DecodeContext = {
    raw: text,
    target: where.label ?? "the target",
    verb: "deploy",
    answer: dryRun ? "preview" : "write",
  };
  if (!isRecord(parsed)) throw malformed("response", kindOf(parsed), raw);

  // `applied` is a boolean, not a truthy value: the difference between "false"
  // and absent is the difference between a preview and an unverifiable write.
  if (typeof parsed.applied !== "boolean") {
    throw malformed("applied", kindOf(parsed.applied), raw);
  }
  // A 200 whose `applied` disagrees with what was asked is refused. A refusal
  // is a non-2xx here by design, so a 200 saying "not applied" on a write is
  // exactly the shape a naive caller would read as success — and a 200 saying
  // "applied" on a dry run means something wrote when nothing should have.
  if (parsed.applied !== !dryRun) {
    throw malformed(
      "applied",
      dryRun
        ? `a dry run must not report \`applied: true\` — something may have been written`
        : `an import reported \`applied: false\` with a success status, so it is not knowable whether anything landed`,
      // A preview that says it applied is no longer a preview: it may have written.
      { ...raw, answer: "write" },
    );
  }

  if (!Array.isArray(parsed.conflicts)) throw malformed("conflicts", kindOf(parsed.conflicts), raw);
  if (!Array.isArray(parsed.canonicals)) throw malformed("canonicals", kindOf(parsed.canonicals), raw);

  const workspace = isRecord(parsed.workspace) ? parsed.workspace : {};

  return {
    workspace: {
      id: typeof workspace.id === "number" ? workspace.id : undefined,
      name: optionalString(workspace.name),
    },
    branch: requiredString(parsed.branch, "branch", raw),
    applied: parsed.applied,
    plan: decodePlan(parsed.plan, raw),
    conflicts: parsed.conflicts.map((entry, i) => decodeConflict(entry, i, raw)),
    canonicals: parsed.canonicals.map((entry, i) => decodeCanonical(entry, i, raw)),
    ...decodeHostedFiles(parsed.hosted_files),
    raw: text,
  };
}

/** The route's `hosted_files` counts, when it sent two whole numbers. */
function decodeHostedFiles(value: unknown): { hostedFiles?: { resolved: number; unresolved: number } } {
  if (!isRecord(value)) return {};
  const { resolved, unresolved } = value;
  if (!Number.isInteger(resolved) || !Number.isInteger(unresolved)) return {};
  return { hostedFiles: { resolved: resolved as number, unresolved: unresolved as number } };
}

/**
 * The hosted-file references an archive makes, and the files it carries.
 *
 * `icons` counts MCP icon placeholders (`xanosdk-file://<canonical>/<name>`):
 * the destination resolves each one and reports the count, so the landing is
 * checked against it. A seeded row's file value (`/vault/_/<canonical>/…`) is
 * not in that count: the destination rewrites it unconditionally as it loads
 * the row, so it cannot land unresolved. What CAN go wrong for both is an
 * archive that names a file without carrying its bytes (a `--bundle` file, a
 * browser-side `export()`), so every referenced canonical is collected and
 * checked against the `vault/` members before anything is sent.
 */
export function hostedReferencesOf(archive: Uint8Array): {
  icons: number;
  referenced: Map<string, string>;
  carried: Set<string>;
} {
  const entries = readArchiveEntries(archive);
  const referenced = new Map<string, string>();
  const carried = new Set<string>();
  let icons = 0;
  for (const name of Object.keys(entries)) {
    const m = /^vault\/([^/]+)\//.exec(name);
    if (m) carried.add(m[1]!);
  }
  const parse = (raw: Buffer | undefined): unknown => {
    if (raw === undefined) return undefined;
    try {
      return (JSON.parse(raw.toString("utf8")) as { payload?: unknown }).payload;
    } catch {
      return undefined;
    }
  };
  const payload = parse(entries["workspace.json"]);
  if (isRecord(payload)) {
    for (const key of HOSTED_ICON_KINDS) {
      const objects = payload[key];
      if (!Array.isArray(objects)) continue;
      for (const obj of objects) {
        const list = isRecord(obj) ? obj.icons : undefined;
        if (!Array.isArray(list)) continue;
        for (const icon of list) {
          if (!isRecord(icon) || typeof icon.src !== "string" || !icon.src.startsWith(HOSTED_FILE_SCHEME)) continue;
          icons++;
          const [canonical = "", file = ""] = icon.src.slice(HOSTED_FILE_SCHEME.length).split("/");
          referenced.set(canonical, decodeURIComponent(file));
        }
      }
    }
  }
  const noteRowValue = (value: unknown): void => {
    const path = isRecord(value) ? value.path : undefined;
    if (typeof path !== "string" || !path.startsWith(HOSTED_ROW_PATH_PREFIX)) return;
    const [canonical = "", , file = ""] = path.slice(HOSTED_ROW_PATH_PREFIX.length).split("/");
    referenced.set(canonical, decodeURIComponent(file));
  };
  for (const [name, raw] of Object.entries(entries)) {
    if (!name.startsWith("content/")) continue;
    const rows = parse(raw);
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isRecord(row)) continue;
      for (const value of Object.values(row)) {
        if (Array.isArray(value)) value.forEach(noteRowValue);
        else noteRowValue(value);
      }
    }
  }
  return { icons, referenced, carried };
}

/** How many MCP icons in the archive name a hosted file — what the landing must account for. */
export function hostedReferencesIn(archive: Uint8Array): number {
  return hostedReferencesOf(archive).icons;
}

/**
 * Refuse, before anything is sent, an archive that names a hosted file it does
 * not carry. The destination skips storing files an archive has none of, so the
 * import would land fields pointing at nothing and still answer success.
 */
function assertHostedFilesCarried(archive: Uint8Array, where: { label?: string }): void {
  const { referenced, carried } = hostedReferencesOf(archive);
  const missing = [...referenced].filter(([canonical]) => !carried.has(canonical)).map(([, name]) => name || "(unnamed)");
  if (missing.length === 0) return;
  throw new ImportNotSentError(
    `This archive references ${missing.length === 1 ? "a hostedFile()" : `${missing.length} hostedFile()s`} it does not carry ` +
      `(${[...new Set(missing)].join(", ")}), so ${where.label ?? "the target"} would store fields pointing at nothing. ` +
      `A bundle written by \`xanosdk export\` or built in a browser carries no hosted files: deploy from an entry file that reads each ` +
      `with \`hostedFile("./<file>", import.meta.url)\`, so the bytes ship with it — a literal \`xanosdk-file://\` src in source ` +
      `carries none, so save the image in the repo and write the hostedFile() line in its place. Nothing was sent.`,
    false,
  );
}

/**
 * A landing that did not account for every `hostedFile(...)` reference as
 * resolved. `applied` says whether the rest of the import landed anyway (a
 * write whose answer lacked the counts) or nothing was written (a preview).
 */
export class HostedFilesUnresolvedError extends Error {
  constructor(message: string, readonly applied: boolean) {
    super(message);
    this.name = "HostedFilesUnresolvedError";
  }
}

/**
 * Refuse an answer that does not account for every hosted-file reference the
 * archive carried as resolved. An instance that does not know the placeholder
 * stores it verbatim and still answers 200, so its silence is exactly the
 * failure this looks for: the field would land pointing at nothing.
 */
function assertHostedFilesResolved(res: XanoSdkImportResponse, expected: number, where: { label?: string }): void {
  if (expected === 0) return;
  const target = where.label ?? "the target";
  const done = res.applied ? "The import has already been applied" : "This preview wrote nothing";
  if (res.hostedFiles === undefined) {
    throw new HostedFilesUnresolvedError(
      `${target} did not report \`hosted_files\` for an archive carrying ${expected} hostedFile() ` +
        `reference${expected === 1 ? "" : "s"}, so it cannot be shown that any of them point at a file there. ` +
        `This instance does not support hostedFile() yet. ${done}${res.applied ? "; redeploy once the instance is updated, or remove the hostedFile() references" : ""}.`,
      res.applied,
    );
  }
  if (res.hostedFiles.resolved < expected || res.hostedFiles.unresolved > 0) {
    throw new HostedFilesUnresolvedError(
      `${target} resolved ${res.hostedFiles.resolved} of the ${expected} hostedFile() references in this archive ` +
        `(${res.hostedFiles.unresolved} unresolved), so a field would point at nothing. ${done}.`,
      res.applied,
    );
  }
}

/**
 * Decode a non-2xx into a {@link XanoSdkImportRefusal}, or `undefined` when the
 * body is not one of this route's refusals.
 *
 * The payload's conflict list is decoded with the SAME decoder the success path
 * uses, so a conflict means one thing in this SDK whichever way it arrived. If
 * that decode fails the call still fails — the refusal stands, only its detail
 * degrades — because a refusal we cannot read in full is still a refusal, and
 * turning it into a decoder error would hide the server's own sentence.
 */
function decodeRefusal(status: number, raw: string, baseUrl: string, label?: string): XanoSdkImportRefusal | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  // The payload's `reason` is the whole signal. The envelope's `code` is the
  // generic bad-request one for every refusal this route raises, so it cannot
  // discriminate; an ordinary bad request — a rejected flag, a bad archive —
  // carries no `reason` at all, which is what separates the two here.
  const payload = isRecord(parsed.payload) ? parsed.payload : {};
  const code = optionalString(payload.reason);
  if (code === undefined) return undefined;

  // The human sentence. A refusal always carries one; falling back to the
  // discriminator keeps the message non-empty rather than reading as unexplained.
  const reason = optionalString(parsed.message) ?? code;

  let conflicts: XanoSdkImportConflict[] = [];
  let canonicals: XanoSdkCanonicalReport[] = [];
  let undecoded: string | undefined;
  const ctx: DecodeContext = { raw, target: label ?? "the target", verb: "deploy", answer: "refusal" };
  try {
    conflicts = Array.isArray(payload.conflicts) ? payload.conflicts.map((e, i) => decodeConflict(e, i, ctx)) : [];
    canonicals = Array.isArray(payload.canonicals) ? payload.canonicals.map((e, i) => decodeCanonical(e, i, ctx)) : [];
  } catch (err) {
    conflicts = [];
    canonicals = [];
    undecoded = err instanceof Error ? err.message : String(err);
  }

  const detail =
    undecoded === undefined
      ? ""
      : `\nThe refusal's detail could not be decoded, so it is not listed below:\n${undecoded}`;

  return new XanoSdkImportRefusal(
    status,
    code,
    reason,
    conflicts,
    canonicals,
    raw,
    `The instance refused this import (${status} ${code}): ${reason}\n` +
      `  instance: ${baseUrl}\n` +
      `The route computes every conflict BEFORE it writes, so nothing was applied.${detail}`,
  );
}

/**
 * One call to the route.
 *
 * `writes` — i.e. `!dryRun` — decides both whether a transport failure may be
 * retried and how the aftermath is worded, so the two can never disagree about
 * which kind of call this was.
 */
async function post(auth: BearerTarget, url: string, opts: XanoSdkImportRequest, action: string): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const writes = !opts.dryRun;
  const attempts = writes ? 1 : READ_ATTEMPTS;

  let res: Response | undefined;
  let failure: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      // No manual Content-Type — fetch sets the multipart boundary for us. The
      // body is rebuilt per attempt, so a retry never reuses a consumed stream.
      const send = (): Promise<Response> =>
        fetchFn(url, {
          method: "POST",
          headers: { accept: "application/json", Authorization: `Bearer ${auth.access_token}` },
          body: body(opts.archive),
          signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
        });
      // A signal while the write is on the wire names it and how to check it.
      res = writes
        ? await describeWrite(
            {
              ...(opts.label === undefined ? {} : { what: `the ${opts.mode === "merge" ? "merge" : "import"} into ${opts.label}` }),
              ...(opts.stateCheck === undefined ? {} : { check: opts.stateCheck }),
            },
            send,
          )
        : await send();
      await noteMetaAnswer(url, res);
      noteRateLimit(res);
      break;
    } catch (err) {
      failure = err;
      // Our own deadline expiring is not the network refusing: retrying spends
      // the same budget again on something already known to be too slow.
      if (isTimeoutError(err) || attempt === attempts - 1) break;
      await sleep(READ_BACKOFF_MS * 2 ** attempt);
    }
  }

  // A transport failure arrives as a bare `fetch failed` with the real reason
  // buried in `cause`. The second question — whether anything landed — has
  // the opposite answer for the two kinds of call, so it is answered here
  // rather than left to the reader. What to do next differs too: a replace
  // rewrites the whole workspace, so running it again converges whichever
  // way the first one went, while a merge's outcome depends on what is there
  // and is worth previewing first. The replace callers (`deploy`, `preflight`)
  // have no dry run to point at.
  // Named as the caller names it (`ephemeral "e4f2-…" ("My App")`, `tenant
  // "eu"`), not as "the workspace": the target is often an ephemeral or a
  // tenant, and a preview that fails is usually the first step of a real
  // write — "the workspace is untouched" named the wrong thing on both counts.
  // The same aftermath whether the request never got through or its answer was
  // lost mid-body: either way the client does not know the outcome.
  const target = opts.label ?? "the target";
  const aftermath = !writes
    ? `A dry run writes nothing, so ${target} is untouched. Retry when the instance is reachable.`
    : opts.mode === "replace"
      ? `The request did not complete, so the import may or may not have landed, in whole or in part. A replace ` +
        `rewrites all of ${target}, so it is safe to run again once the instance is reachable.`
      : `The request did not complete, so the import may or may not have landed, in whole or in part.` +
        (opts.stateCheck !== undefined ? ` ${opts.stateCheck}` : "");
  // The host, never the URL: the route path and its query (the write's
  // flags) are the SDK's wire protocol, not something to print.
  const where = `${transportTarget(url)}${opts.label !== undefined ? ` (${opts.label})` : ""}`;

  if (res === undefined) {
    // A connection that never opened (refused, DNS miss) sent nothing: that is
    // proven, not unknown, and says to retry — never "may or may not have
    // landed", which exits 9 and sends the reader to check a write that never went.
    // Loaded here: it reads the write transports' error classes.
    const { classifyFailure } = await import("../emit/operation-outcome.js");
    if (writes && !isTimeoutError(failure) && classifyFailure(failure, { writeSent: true }) === "no") {
      // A refused certificate already says nothing was sent and that a retry
      // will not help; its fix is not a wait.
      const untrusted = certificateFailureCode(failure) !== undefined;
      throw new ImportNotSentError(
        `${closeSentence(`${action} could not reach ${where}: ${describeTransportFailure(failure)}`)}\n` +
          `Nothing was sent, so ${target} is untouched${untrusted ? "." : " — retry once the instance is reachable."}`,
        false,
        { cause: failure },
      );
    }
    // A connection that opened and dropped reached the instance: the answer
    // was lost, not the instance unreachable.
    const head = `${action} could not reach ${where}: ${describeTransportFailure(failure)}`;
    throw new TransportError(`${closeSentence(writes ? lostAnswerHead(head, failure) : head)}\n${aftermath}`, isTimeoutError(failure), {
      cause: failure,
    });
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    // The answer died mid-body: said as that, host only, with the same aftermath.
    const lost = explainBodyFailure(err, { url, what: action, timeoutMs: IMPORT_TIMEOUT_MS, aftermath, display: where });
    throw lost;
  }
  if (!res.ok) {
    const refusal = decodeRefusal(res.status, text, opts.baseUrl, opts.label);
    if (refusal !== undefined) throw refusal;
    // Not a refusal — an ordinary HTTP failure, reported with the server's own
    // message. No stale-lock advice is appended to a duplicate-identity error:
    // this route pre-flights identity before it writes and names the conflict
    // itself, so that database text does not mean "the lock matched nothing".
    // A replace's own 5xx is read as nothing landed, and a gateway's 502/503/504
    // stands in for an answer the route may never have sent, so it carries the
    // aftermath a lost answer does. A MERGE's own 5xx is unknown too: a merge
    // the instance failed part-way has been seen to leave part of it applied.
    // A dry run wrote nothing either way.
    throw new ImportHttpError(
      res.status,
      action,
      res.statusText,
      text,
      writes ? writeStatusAftermath(res.status, aftermath, { atomic: opts.mode === undefined || opts.mode === "replace" }) : undefined,
    );
  }
  return text;
}

/**
 * Refuse a branch release the route has not POSITIVELY confirmed it understood.
 *
 * The route always echoes the branch it planned against — the live label when
 * none was sent — so a mismatch or an absence here means the request was
 * reshaped somewhere between the caller and the plan. Left exported so the
 * release command can state the same refusal against a response it already
 * holds.
 */
export function assertXanoSdkBranchHonored(res: XanoSdkImportResponse, requested: string, baseUrl: string): void {
  if (res.branch === requested) return;
  throw new Error(
    `Refusing to deploy to branch "${requested}": the instance planned against "${res.branch}".\n` +
      `  instance: ${baseUrl}\n` +
      `A deploy that looked staged would have written to a different branch, which is not ` +
      `recoverable — so it is not attempted against an instance that has not confirmed the target.`,
  );
}

/** The branch id every workspace's default branch (`v1`) carries. */
const DEFAULT_BRANCH_ID = 0;

/**
 * The archive with its workspace pointing at the default branch, for a replace.
 *
 * A replace saves the archive's `workspace` node onto the workspace row, then
 * deletes every branch row, then imports onto the branch the saved row points
 * at. Only the default branch outlives the clear. A platform export carries
 * `branch: {id: 0}`, so the pointer lands there. A compiled bundle carries no
 * `branch`, so the row kept pointing at whichever branch was live. When that
 * was not `v1`, the import landed on a branch the clear had just deleted: the
 * logic was lost, and the replace still reported success.
 *
 * An archive that already points at the default branch goes through untouched.
 * Any other is re-signed over exactly what is written — but only when its
 * signature held BEFORE the pointer moved (`signatureHolds`). An archive
 * edited after it was signed keeps its stale signature, so the engine still
 * refuses it for tampering and the caller's signature remedy fires: re-signing
 * it here blessed every edited `--bundle` a replace sent (E2E pass 21). An
 * unsigned archive stays unsigned.
 */
export function withDefaultBranchPointer(archive: Uint8Array): Uint8Array {
  const entries = readArchiveEntries(archive);
  const raw = entries["workspace.json"];
  if (raw === undefined) return archive;
  const envelope = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  const payload = envelope.payload as Record<string, unknown> | undefined;
  const workspace = payload?.workspace as Record<string, unknown> | undefined;
  if (payload === undefined || workspace === undefined) return archive;
  const branch = workspace.branch as { id?: unknown } | undefined;
  if (branch?.id === DEFAULT_BRANCH_ID) return archive;

  const held = signatureHolds(raw.toString("utf8"));
  const { sig: stored, ...unsigned } = envelope;
  const pinned = {
    ...unsigned,
    payload: { ...payload, workspace: { ...workspace, branch: { id: DEFAULT_BRANCH_ID } } },
  };
  const signed = held === undefined ? pinned : { ...pinned, sig: held ? calcSignatureJson(pinned) : stored };
  const files: TarFile[] = [{ name: "workspace.json", data: Buffer.from(JSON.stringify(signed), "utf8") }];
  for (const [name, data] of Object.entries(entries)) {
    if (name !== "workspace.json") files.push({ name, data });
  }
  return tarGz(files);
}

/**
 * Preview or apply an archive through the xanosdk import route.
 *
 * Call it once with `dryRun: true` to get the plan, the conflicts and the
 * canonical outcomes, then once with `dryRun: false` to apply. Both calls send
 * the same archive and the same options; only the field changes, which is what
 * makes the preview a truthful preview.
 *
 * Throws {@link XanoSdkImportRefusal} when the route declined (nothing written),
 * and an ordinary `Error` for a transport failure, an HTTP failure, or a
 * response this decoder cannot verify.
 *
 * A 404 here is reported as an HTTP failure, not as a reason to fall back: by
 * this point the archive has already been sent. A caller that needs to know in
 * advance asks {@link detectXanoSdkImportRoute}.
 *
 * Takes a {@link BearerTarget}, not a full credential: the transport reads
 * nothing but the bearer, which is what lets a Xano Engine hand in its
 * own url and token without being widened into a credential.
 */
export async function xanosdkImport(auth: BearerTarget, opts: XanoSdkImportRequest): Promise<XanoSdkImportResponse> {
  const action = opts.dryRun ? "The deploy preview" : "The deploy";
  // The route's own default mode is replace, so an unset mode is one too.
  const replaces = opts.mode === undefined || opts.mode === "replace";
  const sent = replaces ? { ...opts, archive: withDefaultBranchPointer(opts.archive) } : opts;
  assertHostedFilesCarried(sent.archive, { label: opts.label });
  const text = await post(auth, endpoint(sent, query(sent)), sent, action);
  const decoded = decodeResponse(text, opts.dryRun, { action, baseUrl: opts.baseUrl, label: opts.label });
  if (opts.branch !== undefined) assertXanoSdkBranchHonored(decoded, opts.branch, opts.baseUrl);
  assertHostedFilesResolved(decoded, hostedReferencesIn(opts.archive), { label: opts.label });
  return decoded;
}
