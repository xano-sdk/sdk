/**
 * What every `release` verb shares: the name a verb operates on, and how a
 * release's branch reads in output.
 *
 * Its own module so `release create` (`release-create.ts`) and the namespace
 * that dispatches to it (`release-ns-command.ts`) can both use these without
 * importing each other.
 */
import { assertOneName } from "./name-argument.js";
import type { ParsedArgs } from "./cli.js";
import type { ResolvedAuth } from "../auth/token.js";
import { findRelease, type ReleaseSummary } from "../deploy/release.js";
import { findReleaseSource } from "../deploy/audit-log.js";
import { DEFAULT_BRANCH_LABEL } from "../deploy/branch.js";
import { UsageError } from "./errors.js";
import { safeText } from "./ui.js";
import { contextFlags } from "./context-flags.js";
import { isUnansweredLookup, lookupFailed, LookupFailedError, unansweredCause } from "./source-resolve.js";
import type { SourceKind } from "./source-selector.js";

/**
 * Exit code for a release command that ran and was refused by what it found: a
 * different release holds the name, or what landed does not match what was
 * sent. Running it again changes nothing. The code the README documents.
 */
export const EXIT_RELEASE_REFUSED = 2;

/** The release name a verb operates on. */
export function requireName(args: ParsedArgs, verb: string): string {
  const name = args.positionals[0];
  if (name === undefined || name === "") {
    throw new UsageError(
      `\`xanosdk release ${verb}\` needs a release name. ` +
        `Run \`xanosdk release list${contextFlags()}\` to see them.`,
      // One line and the pointer: the sentence says what to type.
      { hintFor: { command: "release", subcommand: verb } },
    );
  }
  assertOneName(name, "the release name", { args, helpFor: { command: "release", subcommand: verb } });
  return name;
}

/**
 * How a release's branch reads in output: its label, or the fallback for a
 * release that names none (`null` — an environment cut) or did not report one.
 * An empty label is tested for too, so a hand-built summary cannot print a
 * blank where a label goes.
 */
export function branchLabel(branch: string | null | undefined, fallback = "-"): string {
  return branch === undefined || branch === null || branch === "" ? fallback : branch;
}

/**
 * Where a release was cut from, as far as anything on the instance records it.
 * `--json` prints it as `origin`:
 * - `{ kind: "branch", label }` — cut from a branch of this workspace;
 * - `{ kind: "environment", name, type }` — cut from an ephemeral or tenant;
 * - `{ kind: "copy", source: { host, workspaceId, release }, from? }` — copied in
 *   by `release transfer` from that release; `from` is where that one was cut
 *   (a branch or an environment), absent when the source recorded neither.
 *   The copy's branch tag is the import's, not a source.
 */
export type ReleaseOrigin =
  | { kind: "branch"; label: string }
  | { kind: "environment"; name: string; type: string | undefined }
  | {
      kind: "copy";
      source: { host: string; workspaceId: number; release: string };
      from?: { kind: "branch"; label: string } | { kind: "environment"; name: string; type: string };
    };

/**
 * Where a release was cut from, or `undefined` when nothing records it.
 *
 * The record names a BRANCH for a workspace cut. An environment cut stores an
 * empty branch — the same spelling an older default workspace cut left — so
 * for that one the origin line the cut wrote into the description is read
 * (`recordedOrigin`), which lasts as long as the release. A release cut before
 * that line was written falls back to the audit entry of the cut, paged back
 * to the release's creation. Best effort: the log is pruned and may not be
 * readable, and either leaves the origin unknown rather than guessed.
 */
export async function releaseOrigin(auth: ResolvedAuth, release: ReleaseSummary): Promise<ReleaseOrigin | undefined> {
  // A copy carries the import's branch tag, which names no source: the record
  // the transfer wrote says what it was copied from, and where that was cut.
  if (release.copiedFrom !== undefined) {
    const { source, cut } = release.copiedFrom;
    if (cut === undefined) return { kind: "copy", source };
    return {
      kind: "copy",
      source,
      from: cut.type === "branch" ? { kind: "branch", label: cut.name } : { kind: "environment", ...cut },
    };
  }
  if (typeof release.branch === "string" && release.branch !== "") return { kind: "branch", label: release.branch };
  if (release.recordedOrigin !== undefined) {
    return { kind: "environment", name: release.recordedOrigin.name, type: release.recordedOrigin.type };
  }
  const created = release.createdAt === undefined ? NaN : Date.parse(release.createdAt);
  const source = await findReleaseSource(auth, {
    workspaceId: auth.workspaceId,
    releaseName: release.name,
    // A margin for clock skew between the record and the log row.
    ...(Number.isNaN(created) ? {} : { notBefore: created - 10 * 60_000 }),
  }).catch(() => null);
  return source === null ? undefined : { kind: "environment", name: source.tenantName, type: source.tenantType };
}

/**
 * The warning a landing prints for the password columns `passwordSeedColumns`
 * (`deploy-source.ts`) finds in a seeded release, naming where it lands.
 *
 * A stored password is a salted HMAC keyed by the key material of the
 * environment that hashed it — every workspace, and every ephemeral or tenant
 * (each is its own workspace), gets its own at creation, and no release or
 * import carries it. The hashes travel byte-for-byte and the import keeps
 * them as they are, so they verify only where they were made. Measured on
 * the same release, identical bytes: landed back on the ephemeral it was cut
 * from, logins work; landed on a new ephemeral, every one is a bad password.
 *
 * `where` is a noun phrase (`ephemeral "pr-3"`, `tenant "acme"`, `the local
 * engine`); `origin` names where the hashes were made, when it is known. A
 * caller skips the warning when it lands on that origin: there they verify.
 *
 * `takesEntryFile` says whether `where` can be deployed from an entry file at
 * all. A standard tenant takes only a release, so "deploy the entry file to
 * seed them from plaintext" names a step that cannot be taken there; its
 * remedy is a reset on the tenant, or a release that leaves those rows out.
 */
export function passwordHashesWarning(
  release: string,
  columns: readonly string[],
  where: string,
  after = "the landing",
  origin?: string,
  takesEntryFile = true,
): string {
  const head =
    `Release "${release}" carries seeded password hashes (${columns.join(", ")}). A password hash is keyed ` +
    `to the environment that made it — every workspace, ephemeral and tenant has its own key, and no release ` +
    `carries it — so `;
  const fix = takesEntryFile
    ? `Deploy the entry file to seed them from plaintext, or reset those passwords after ${after}.`
    : `${where[0]!.toUpperCase()}${where.slice(1)} takes only a release, so they cannot be seeded from ` +
      `plaintext there: reset those passwords on it after ${after}, or land a release cut without that ` +
      `table's rows (\`release create\` without its \`--seed\` guid).`;
  // Unknown origin: the landing may BE the environment the release was cut
  // from, where they verify — so the failure is stated as conditional.
  return origin === undefined
    ? `${head}logins against these rows fail on ${where} as a bad password unless it is the environment ` +
        `the release was cut from, which is not recorded. ${fix}`
    : `${head}these verify only on ${origin}, and logins against these rows will fail on ${where} as a ` +
        `bad password. ${fix}`;
}

/**
 * Where a release's seeded rows were hashed, as a noun phrase and — for an
 * environment cut — a name to compare a destination with; the workspace, with
 * no name, for a branch cut. `undefined` when nothing records it (see
 * {@link releaseOrigin}). Takes the record when the caller has it, else the
 * name. Best effort, for the warning above.
 */
export async function passwordOrigin(
  auth: ResolvedAuth,
  release: string | ReleaseSummary,
): Promise<{ name: string | undefined; phrase: string } | undefined> {
  const name = typeof release === "string" ? release : release.name;
  const found =
    typeof release === "string"
      ? await findRelease(auth, { workspaceId: auth.workspaceId, name }).catch(() => null)
      : release;
  let origin: ReleaseOrigin | undefined;
  if (found !== null) {
    origin = await releaseOrigin(auth, found);
  } else {
    const source = await findReleaseSource(auth, { workspaceId: auth.workspaceId, releaseName: name }).catch(
      () => null,
    );
    if (source !== null) origin = { kind: "environment", name: source.tenantName, type: source.tenantType };
  }
  if (origin === undefined) return undefined;
  // A copy of an environment cut: its rows were hashed there, on the workspace
  // it was copied from — no environment of this one, whatever its name.
  if (origin.kind === "copy") {
    return {
      name: undefined,
      phrase:
        origin.from?.kind === "environment"
          ? `${describeOrigin(origin.from)} of the workspace the release was copied from`
          : "the workspace the release was copied from",
    };
  }
  // A branch cut hashed its rows in the workspace, which no landing target is.
  // The default branch is also the tag an import gives a copy, so for it the
  // workspace is named as the one that cut it — possibly another one.
  if (origin.kind === "branch") {
    return {
      name: undefined,
      phrase: origin.label === DEFAULT_BRANCH_LABEL ? "the workspace that cut it" : `the workspace (${describeOrigin(origin)})`,
    };
  }
  return { name: origin.name, phrase: describeOrigin(origin) };
}

/**
 * An origin in a sentence: `branch "v1"`, `ephemeral "pr-3"`,
 * `release "v2" of workspace 7 on x.example.com (copied; cut there from ephemeral "pr-3")`.
 */
export function describeOrigin(origin: ReleaseOrigin): string {
  if (origin.kind === "copy") {
    const { release, workspaceId, host } = origin.source;
    return (
      `release ${safeText(JSON.stringify(release))} of workspace ${workspaceId} on ${safeText(host)} ` +
      `(copied${origin.from === undefined ? "" : `; cut there from ${describeOrigin(origin.from)}`})`
    );
  }
  return origin.kind === "branch"
    ? `branch "${safeText(origin.label)}"`
    : `${origin.type ?? "environment"} "${safeText(origin.name)}"`;
}

/**
 * A read that got no answer, said as {@link lookupFailed} says a lookup: exit 8
 * (unreachable) and — once the dispatcher names it — this command line as the
 * rerun, rather than a bare transport error's exit 1 and "retry.". Only the
 * failure's first line is kept, so no multi-line message nests inside the
 * sentence. Anything else is returned as it is.
 *
 * `what` completes "Could not …": `list releases`, `search profile "p"'s
 * workspace for release "v1"`. `not` is what the failure must not be read as.
 */
export function readUnanswered(kind: SourceKind, what: string, not: string, err: unknown): unknown {
  // A server error (5xx) is no answer either (E2E pass 29).
  if (!isUnansweredLookup(err)) return err;
  const first = ((err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "").trim().replace(/[.:]$/, "");
  const cause = unansweredCause(err);
  return new LookupFailedError(
    `Could not ${what}: ${first}. ${cause}, not ${not} — nothing was created or changed`,
    "unreachable",
    kind,
  );
}

/**
 * The release's lookup, with one that got no answer as {@link lookupFailed}:
 * exit 8 and this command line as the rerun, as `deploy release:<name>` says it
 * — not a bare transport error's exit 1 (E2E pass 21).
 */
export async function lookupRelease(auth: ResolvedAuth, name: string): Promise<ReleaseSummary | null> {
  try {
    return await findRelease(auth, { workspaceId: auth.workspaceId, name });
  } catch (err) {
    if (isUnansweredLookup(err)) throw lookupFailed("release", name, err);
    throw err;
  }
}
