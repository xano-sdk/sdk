/**
 * Node-only transport for a workspace's BRANCHES — the meta API surface behind
 * `xanosdk workspace branch …` and behind `deploy --to … --branch` / `--backup-branch`.
 *
 * A Xano workspace holds many branches and exactly one of them is LIVE: the one
 * the runtime serves and the one an unqualified import lands on. Branches are
 * the platform's staging boundary for a team that has only one workspace, which
 * is the whole point — promote to a branch, look at it, then make
 * it live.
 *
 * What is branch-scoped and what is not matters more here than anywhere else in
 * the SDK, so it is stated once, at the source: API groups, functions, tasks,
 * triggers, middleware, tools, toolsets, channels, realtime servers, knowledge,
 * addons and messages all belong to a branch. **Tables and microservices do
 * not** — they are workspace-scoped and shared by every branch. So a branch
 * stages your LOGIC and shares your SCHEMA, and no amount of branch targeting
 * changes that. {@link ../deploy/live-diff.ts} is where the SDK detects the
 * difference and the release command is where it refuses to cross it silently.
 *
 * The URL is built by string concatenation (not `new URL(path, base)`) so a
 * self-hosted base URL carrying a `/tenant/{name}` path prefix is preserved
 * rather than discarded — the same rule the import transport follows.
 */
import type { ResolvedAuth } from "../auth/token.js";
import { contextFlags } from "../emit/context-flags.js";
import { pipedYes } from "../emit/retry-command.js";
import { shellWord } from "../emit/command-line.js";
import { suggestAll } from "../util/suggest.js";
import { asTimestamp } from "../util/timestamp.js";
import { noteMetaAnswer } from "../util/last-credential.js";
import {
  describeTransportFailure,
  httpFailure,
  parseJsonAnswer,
  retryingFetch,
  transportTarget,
  withWriteStatusAftermath,
} from "../util/http.js";

/** Branch calls are small JSON reads/writes — nothing to stream, so bound them tightly. */
const BRANCH_TIMEOUT_MS = 30_000;

/**
 * A branch route that answered, and answered with a failure.
 *
 * Typed so a caller can read the STATUS without parsing a sentence: a 4xx on a
 * set-live or a create means the server refused it and nothing changed, a 5xx
 * means the switch may have happened before the failure was reported.
 *
 * The message is {@link httpFailure}'s, with a write's
 * {@link withWriteStatusAftermath} line under it when the status is not a refusal.
 */
export class BranchHttpError extends Error {
  constructor(
    readonly status: number,
    action: string,
    statusText: string,
    body: string,
    write = false,
  ) {
    const head = httpFailure(action, { status, statusText }, body);
    super(write ? withWriteStatusAftermath(head, status) : head);
    this.name = "BranchHttpError";
  }
}

/**
 * The label of the branch every workspace starts with.
 *
 * Reserved by the engine: it is not stored as an ordinary branch row, which is
 * why a create/import naming it is not caught by an "already exists" check and
 * has to be refused here instead. Measured, not assumed — an import naming this
 * label was not rejected by the route.
 */
export const DEFAULT_BRANCH_LABEL = "v1";

/** One branch as the meta API reports it. */
export interface BranchRecord {
  /** Numeric id. Absent from some list shapes, so never relied on for identity. */
  id?: number;
  /** The label — the branch's identity everywhere in the SDK. */
  label: string;
  /** True for the branch the runtime currently serves. */
  live: boolean;
  /** True for a branch the platform created as a backup snapshot. */
  backup: boolean;
  createdAt?: string;
}

/** `{baseUrl}/api:meta/workspace/{id}/branch{suffix}` — concatenated, never resolved. */
function endpoint(baseUrl: string, workspaceId: number, suffix = ""): string {
  return `${baseUrl.replace(/\/$/, "")}/api:meta/workspace/${workspaceId}/branch${suffix}`;
}

/**
 * A branch label refused before anything is sent: a mistake in what was typed,
 * so it carries the usage code a `--json` failure document branches on, not the
 * generic one. (This layer does not import the CLI's error classes; the code is
 * read off the error by shape.)
 */
export class BranchLabelError extends Error {
  override readonly name = "BranchLabelError";
  readonly code = "SDK_USAGE";
}

/**
 * A label the workspace does not have. Exits 8, the code every other named
 * thing that is not there exits with (a release, a tenant, an ephemeral).
 */
export class BranchNotFoundError extends Error {
  override readonly name = "BranchNotFoundError";
  readonly exitCode = 8;
  /** The near label a typo most likely meant — the document's `suggestion`. */
  readonly suggestion: string | undefined;
  /** Every near label, when several tie. */
  readonly suggestions: string[] | undefined;
  constructor(message: string, near: readonly string[] = []) {
    super(message);
    this.suggestion = near[0];
    this.suggestions = near.length > 1 ? [...near] : undefined;
  }
}

/**
 * The characters a branch label may carry: a letter, digit or underscore first,
 * then letters, digits, underscores, dashes and dots.
 *
 * The rule the platform's own branch forms enforce. The import route does not
 * enforce it — a label with a space or a slash is stored as typed — so a label
 * outside it is refused here, or it would become a branch the dashboard cannot
 * edit and a shell cannot pass back without quoting.
 */
export const BRANCH_LABEL_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * The branch label the SDK will send, or a refusal naming why not.
 *
 * The one validator every path that WRITES a branch label goes through: a
 * promote, `deploy --to workspace --branch`, `--backup-branch`, and the branch
 * create call. Surrounding whitespace is trimmed first and the TRIMMED label is
 * returned — the caller sends that, never the raw flag value, so `--branch " x "`
 * lands on `x` rather than on a padded branch nothing can name afterwards.
 *
 * Every refusal here was measured against a live engine: none of these labels
 * is rejected before the import does real work, so refusing here is the only
 * thing standing between a typo and a branch nobody can address.
 */
export function assertUsableBranchLabel(
  label: string,
  flag: string,
  /**
   * What dropping the flag does, for the refusal's last line. The default is a
   * release's: no flag lands on the live branch. A command whose unflagged
   * landing goes elsewhere says so, or the advice sends the reader somewhere
   * the command never goes.
   */
  withoutFlag = "drop the flag to release to whichever branch is currently live",
): string {
  const trimmed = label.trim();
  if (trimmed === "") {
    throw new BranchLabelError(
      `\`${flag}\` needs a branch label and was given an empty one.\n` +
        `The engine does not reject an empty label — it would create a branch with no name, which ` +
        `cannot be selected, promoted or deleted afterwards.`,
    );
  }
  if (trimmed === DEFAULT_BRANCH_LABEL) {
    throw new BranchLabelError(
      `\`${flag}=${DEFAULT_BRANCH_LABEL}\` names the workspace's DEFAULT branch, which is reserved.\n` +
        `The engine does not store it as an ordinary branch, so it is not caught by an ` +
        `"already exists" check — targeting it does not stage anything, it writes to the branch ` +
        `every workspace starts on.\n` +
        `Pick a different label, or ${withoutFlag}.`,
    );
  }
  if (!BRANCH_LABEL_PATTERN.test(trimmed)) {
    throw new BranchLabelError(
      `\`${flag}\` was given "${trimmed}", which is not a usable branch label.\n` +
        `A label starts with a letter, digit or underscore and carries only letters, digits, ` +
        `underscores, dashes and dots (e.g. \`staging\`, \`release-2.1\`) — no spaces or slashes.`,
    );
  }
  return trimmed;
}

/**
 * The branch a caller NAMED, found in a listing, for the verbs that act on a
 * branch that already exists (`workspace branch set-live|delete`,
 * `release create --from workspace --branch`).
 *
 * Not {@link assertUsableBranchLabel}: a branch stored before that rule — one
 * with a space in it, say — must stay reachable, or it could never be cleaned
 * up. So nothing is refused on its characters; the typed label is matched
 * exactly first, then with surrounding whitespace ignored on both sides, which
 * is how a padded label an older promote stored is found by the label a person
 * types. The record returned carries the label AS STORED, and that is what the
 * caller sends.
 *
 * `undefined` when nothing matches, or when the whitespace-blind match is
 * ambiguous — the caller refuses then, listing what does exist.
 */
export function findBranch(branches: readonly BranchRecord[], label: string): BranchRecord | undefined {
  const exact = branches.find((b) => b.label === label);
  if (exact !== undefined) return exact;
  const trimmed = label.trim();
  if (trimmed === "") return undefined;
  const near = branches.filter((b) => b.label.trim() === trimmed);
  return near.length === 1 ? near[0] : undefined;
}

/**
 * The init every branch request shares.
 *
 * Headers are MERGED, never spread over: a caller passing `Content-Type` would
 * otherwise replace the whole header object and send the request
 * unauthenticated, which reads as a 401 from the endpoint rather than as the
 * local mistake it is. Caller keys win on conflict; `Authorization` is not a
 * key any caller here sets.
 */
function requestInit(auth: ResolvedAuth, init: RequestInit): RequestInit {
  return {
    signal: AbortSignal.timeout(BRANCH_TIMEOUT_MS),
    ...init,
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${auth.access_token}`,
      ...((init.headers ?? {}) as Record<string, string>),
    },
  };
}

/** A dropped connection, as a sentence naming the route and the reason. */
function unreachable(action: string, url: string, err: unknown): Error {
  return new Error(`${action} could not reach ${transportTarget(url)}: ${describeTransportFailure(err)}`, { cause: err });
}

/** The body of a response that answered, or the typed failure when it answered no. */
async function bodyOf(res: Response, action: string, write = false): Promise<string> {
  const text = await res.text();
  if (!res.ok) throw new BranchHttpError(res.status, action, res.statusText, text, write);
  return text;
}

/**
 * A branch WRITE: exactly one attempt.
 *
 * Create, set-live and delete come through here. A set-live that landed before
 * the connection dropped must not be sent a second time, so there is no retry
 * — and no way to ask for one: the retrying transport is only reachable from
 * {@link read}.
 */
async function call(auth: ResolvedAuth, url: string, init: RequestInit, action: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, requestInit(auth, init));
    await noteMetaAnswer(url, res);
  } catch (err) {
    throw unreachable(action, url, err);
  }
  return bodyOf(res, action, true);
}

/**
 * A branch READ: a GET, retried on a dropped connection.
 *
 * The list is the read a promote interrupted mid-landing names as its
 * resolver, so it has to survive the same blip that interrupted the landing.
 */
async function read(auth: ResolvedAuth, url: string, action: string): Promise<string> {
  let res: Response;
  try {
    res = await retryingFetch(url, requestInit(auth, { method: "GET" }));
  } catch (err) {
    throw unreachable(action, url, err);
  }
  return bodyOf(res, action);
}

/**
 * A branch the engine reports but nothing can name.
 *
 * It has no label, and the list shape carries no id either, so there is no
 * handle to select, promote or delete it with — every branch route addresses a
 * branch BY LABEL. It is reported rather than dropped because the alternative
 * is what made it hard to find: a workspace can hold one of these and every
 * `xanosdk` view of the branch list looked normal.
 *
 * Where they come from: a release deploy that named no branch. The engine's
 * answer to a missing label is a branch with an empty one, so older CLI
 * versions left one behind on each promote. The CLI names every branch it lands
 * on, so it does not create them — this only surfaces what already exists.
 */
export interface UnaddressableBranch {
  readonly live: boolean;
  readonly backup: boolean;
  readonly createdAt?: string;
}

/** Both halves of a branch listing, from one read. */
export interface BranchListing {
  /** Branches that can be named — everything the CLI can act on. */
  readonly branches: BranchRecord[];
  /** Rows carrying no usable label. Empty for a healthy workspace. */
  readonly unaddressable: UnaddressableBranch[];
}

/** Coerce one server row into a {@link BranchRecord}, tolerating a missing `live`/`backup`. */
function toRecord(entry: unknown): BranchRecord | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const row = entry as Record<string, unknown>;
  const label = row.label;
  if (typeof label !== "string" || label === "") return undefined;
  return {
    ...(typeof row.id === "number" ? { id: row.id } : {}),
    label,
    // Absent means false: the list shape omits `live` on non-live rows.
    live: row.live === true,
    backup: row.backup === true,
    ...(typeof row.created_at === "string" ? { createdAt: asTimestamp(row.created_at) ?? row.created_at } : {}),
  };
}

/**
 * Every branch in the workspace, split by whether it can be named.
 *
 * The split is the whole point: every caller that ACTS on a branch needs the
 * addressable ones and nothing else, while the listing a person reads needs to
 * admit the rest exists. Returning one array of both would push that judgement
 * onto call sites that have no reason to think about it.
 */
export async function listBranchListing(
  auth: ResolvedAuth,
  opts: { baseUrl: string; workspaceId: number },
): Promise<BranchListing> {
  const text = await read(auth, endpoint(opts.baseUrl, opts.workspaceId), "list branches");
  const parsed = parseJsonAnswer(text, "list branches", opts.baseUrl);
  if (!Array.isArray(parsed)) {
    // The shape, not the body: a JSON answer from the wrong service is still
    // not something to paste into a terminal.
    throw new Error(`list branches: ${transportTarget(opts.baseUrl)} answered with JSON that is not a list of branches.`);
  }
  const branches: BranchRecord[] = [];
  const unaddressable: UnaddressableBranch[] = [];
  for (const entry of parsed) {
    const record = toRecord(entry);
    if (record !== undefined) {
      branches.push(record);
      continue;
    }
    // A row that is not an object at all is a shape we do not understand and
    // cannot report anything useful about; an object with no usable label is
    // the case worth naming.
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    unaddressable.push({
      live: row.live === true,
      backup: row.backup === true,
      ...(typeof row.created_at === "string" ? { createdAt: asTimestamp(row.created_at) ?? row.created_at } : {}),
    });
  }
  return { branches, unaddressable };
}

/**
 * Every branch in the workspace that can be NAMED, live one included.
 *
 * The right read for anything that acts on a branch — a collision check, a
 * cutover, a `--branch` lookup. Use {@link listBranchListing} where the caller
 * has to report what it cannot act on.
 */
export async function listBranches(
  auth: ResolvedAuth,
  opts: { baseUrl: string; workspaceId: number },
): Promise<BranchRecord[]> {
  return (await listBranchListing(auth, opts)).branches;
}

/** The live branch's label, or `undefined` when the server names none. */
export function liveBranchLabel(branches: readonly BranchRecord[]): string | undefined {
  return branches.find((b) => b.live)?.label;
}

/**
 * Create a branch by CLONING an existing one.
 *
 * There is no "empty branch" — a new branch always starts as a copy of a source,
 * which is what makes this usable as a pre-release snapshot: cloning the live
 * branch captures exactly what is about to be overwritten.
 */
export async function createBranch(
  auth: ResolvedAuth,
  opts: {
    baseUrl: string;
    workspaceId: number;
    label: string;
    sourceBranch?: string;
    description?: string;
  },
): Promise<BranchRecord> {
  const label = assertUsableBranchLabel(opts.label, "branch label");
  const text = await call(
    auth,
    endpoint(opts.baseUrl, opts.workspaceId),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_branch: opts.sourceBranch ?? DEFAULT_BRANCH_LABEL,
        label,
        description: opts.description ?? "",
      }),
    },
    "create branch",
  );
  const parsed = parseJsonAnswer(text, "create branch", opts.baseUrl);
  const record = toRecord(parsed);
  if (record === undefined) {
    throw new Error(`create branch: ${transportTarget(opts.baseUrl)} answered, but named no branch.`);
  }
  return record;
}

/**
 * Promote a branch to live.
 *
 * This is a production cutover — the runtime serves the new branch the moment it
 * returns — so every caller in the SDK confirms before reaching it.
 */
export async function setLiveBranch(
  auth: ResolvedAuth,
  opts: { baseUrl: string; workspaceId: number; label: string },
): Promise<void> {
  await call(
    auth,
    `${endpoint(opts.baseUrl, opts.workspaceId, `/${encodeURIComponent(opts.label)}/live`)}`,
    { method: "POST" },
    "set live branch",
  );
}

/** Delete a branch. Never called implicitly — only where a user asked for it. */
export async function deleteBranch(
  auth: ResolvedAuth,
  opts: { baseUrl: string; workspaceId: number; label: string },
): Promise<void> {
  await call(
    auth,
    endpoint(opts.baseUrl, opts.workspaceId, `/${encodeURIComponent(opts.label)}`),
    { method: "DELETE" },
    "delete branch",
  );
}

/**
 * Refuse a label that is already taken, naming both ways forward.
 *
 * Kept here rather than at the call site so the release path and the branch
 * commands raise the same message for the same condition.
 */
export function assertBranchAbsent(
  branches: readonly BranchRecord[],
  label: string,
  /** `backup`: the label a `--backup-branch` snapshot would take — nothing is deployed into it. */
  purpose: "deploy" | "backup" = "deploy",
): void {
  // Matched as `findBranch` matches, trimmed: a stored "  x  " IS the branch a
  // `--branch x` names everywhere else, and an exact-only check let a second,
  // visually identical "x" be created beside it.
  const trimmed = label.trim();
  const held = branches.find((b) => b.label === label) ?? branches.find((b) => b.label.trim() === trimmed);
  if (held === undefined) return;
  const shown = held.label === label ? `"${label}"` : `${JSON.stringify(held.label)} (the stored label of "${label}")`;
  const free = freeBranchLabel(branches, trimmed);
  // The live branch cannot be deleted, so its remedy is a free label or a
  // set-live of another branch first — never a delete that would refuse.
  if (purpose === "backup") {
    throw new BranchTakenError(
      `A branch named ${shown} already exists in this workspace, so \`--backup-branch\` cannot snapshot ` +
        `the live branch under that label — a snapshot is always a new branch.\n` +
        `Choose another label (\`${free}\` is free), or pass \`--backup-branch\` with no label for a timestamped one.`,
      held.label,
      free,
    );
  }
  const remedy = held.live
    ? `It is the LIVE branch, so it cannot be deleted. Pick a label that is free (\`${free}\` is), or make ` +
      `another branch live first (\`xanosdk workspace branch set-live <other>${pipedYes()}${contextFlags()}\`) and then delete it.`
    : `Pick a label that is free (\`${free}\` is), or delete it first with ` +
      `\`xanosdk workspace branch delete ${shellWord(held.label)}${pipedYes()}${contextFlags()}\`.`;
  throw new BranchTakenError(
    `A branch named ${shown} already exists in this workspace.\n` +
      `Deploying into it is not offered: it would be a fresh import over a branch someone may be ` +
      `reviewing, and the SDK cannot tell those apart.\n` +
      remedy,
    held.label,
    free,
  );
}

/**
 * A label another branch already holds. A conflict, not a failure: it exits 2,
 * the code a taken release name gives, with `SDK_BRANCH_TAKEN` and the holder
 * under `details.conflictsWith` — re-running changes nothing.
 */
export class BranchTakenError extends Error {
  override readonly name = "BranchTakenError";
  readonly code = "SDK_BRANCH_TAKEN";
  readonly exitCode = 2;
  readonly details: { conflictsWith: { branch: string }; freeLabel?: string };
  constructor(
    message: string,
    /** The label as stored — what `workspace branch delete` takes. */
    readonly label: string,
    /** A label no branch holds, to deploy under instead. */
    freeLabel?: string,
  ) {
    super(message);
    this.details = { conflictsWith: { branch: label }, ...(freeLabel === undefined ? {} : { freeLabel }) };
  }
}

/**
 * The tail of a label the CLI derives (a promote's, a backup's): a compact UTC
 * stamp, so a workspace's branches sort chronologically, and four random hex
 * digits, so two runs in the same second do not derive the same label — the
 * instance refuses the second with a duplicate-record failure.
 */
export function derivedLabelTail(now: Date, random: () => number = Math.random): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const tag = Math.floor(random() * 0x10000).toString(16).padStart(4, "0");
  return `${stamp}-${tag}`;
}

/**
 * `<label>-<4 random hex>` that no branch holds (compared trimmed). Random, as
 * a derived label's tail is: two runs that lost the same label race are each
 * offered their own, where a counted `-2` sent both into the next collision.
 */
export function freeBranchLabel(
  branches: readonly BranchRecord[],
  label: string,
  random: () => number = Math.random,
): string {
  const taken = new Set(branches.map((b) => b.label.trim()));
  for (;;) {
    const candidate = `${label}-${Math.floor(random() * 0x10000).toString(16).padStart(4, "0")}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Resolve a label the caller expects to exist, with a message that lists what does.
 *
 * Matched through {@link findBranch}, so a label differing from the stored one
 * only by surrounding whitespace resolves to the stored branch. "No such
 * branch" is the error most likely to be a typo, and the fix is almost always
 * visible in the list the server just returned.
 */
export function requireBranch(branches: readonly BranchRecord[], label: string): BranchRecord {
  const found = findBranch(branches, label);
  if (found !== undefined) return found;
  // Quoted only when whitespace would otherwise hide what the label is.
  const known = branches.map((b) => (/\s/.test(b.label) ? JSON.stringify(b.label) : b.label)).join(", ");
  const near = suggestAll(label.trim(), branches.map((b) => b.label));
  throw new BranchNotFoundError(
    `This workspace has no branch named "${label}".\n` +
      (known === "" ? `It reports no branches at all.` : `It has: ${known}`) +
      (near.length === 0 ? "" : `\nDid you mean ${near.map((n) => JSON.stringify(n)).join(" or ")}?`),
    near,
  );
}
