/**
 * `xanosdk release transfer <name> --to-profile <profile>` — copy a stored
 * release to another workspace or instance, with evidence that the destination
 * holds the same archive.
 *
 * It moves the ARCHIVE and nothing else: no compile, no deploy, no branch. The
 * release the destination ends up holding carries the same archive the source
 * holds, which is what makes it promotable there with the same meaning.
 *
 * ## The destination is a second credential, not a second flag set
 *
 * The command runs as the active credential (the source) and resolves
 * `--to-profile` beside it, so the destination carries its own instance,
 * workspace and refreshable credential. The two sides are refused when they are
 * the same instance and workspace — a transfer onto itself can only mint a
 * suffixed duplicate.
 *
 * ## Reconciled on the client, by content hash
 *
 * The platform offers no idempotency key for an import, so a re-run must find
 * its own earlier work. It does that by sha256 over the archive's TAR (every
 * gzip layer peeled — see `contentSha256` for why not the downloaded bytes),
 * keyed on the release name EMBEDDED in the archive (`N`), not the source's
 * stored name:
 * an import stores the release under `N`, or `N-` plus four hex characters when
 * `N` is taken. So the candidates are exactly those names, and:
 *
 * - an identical candidate is REUSED — nothing is imported (exact `N` first, then
 *   the lowest id, so the answer is the same on every run);
 * - a different release holding `N` is a CONFLICT and refused, never overwritten;
 * - otherwise the archive is imported, read back by the id the import returned,
 *   re-downloaded and re-hashed.
 *
 * Every candidate is downloaded: no stored field identifies content, and the
 * size a release reports is the size of whatever was uploaded to create it.
 *
 * ## A transfer never deletes
 *
 * A post-import hash mismatch is reported as `no`, with the import named as
 * residue and the command that removes it; a duplicate left by a concurrent run
 * is reported as `duplicateOf`. Removing either is a consequential write of its
 * own, and nothing asked this command for one.
 *
 * ## What it reports
 *
 * The shared operation result (`operation-result.ts`), steps `read`, `search`,
 * `import`, `verify`. `read` is the SOURCE side — finding the release and
 * downloading it — so a release that is not there fails as `read: no`, not as a
 * search of the destination that never ran. `release` is the DESTINATION
 * release; `source` is where it came from. `import` is `skipped` when an
 * identical release was reused. `--dry-run` runs the read and the search and
 * says whether the transfer is already `present`.
 */
import { assertOneName } from "./name-argument.js";
import type { ParsedArgs } from "./cli.js";
import { getAccessToken, resolveNamedProfile, ProfileNotFoundError, type ResolvedAuth } from "../auth/token.js";
import { CliError, UsageError } from "./errors.js";
import { contextFlags } from "./context-flags.js";
import { pipedYes } from "./retry-command.js";
import { SourceError } from "./source-resolve.js";
import { isMachineOutput } from "./output.js";
import { confirm } from "./prompt.js";
import { yesRerun } from "./retry-command.js";
import { step, success, warn, detail, info, safeText, describeWriteTarget, discloseWriteTarget, type WriteTarget } from "./ui.js";
import {
  createOperation,
  runOperation,
  type OperationBuilder,
  type OperationRelease,
} from "./operation-result.js";
import {
  listReleases,
  getRelease,
  downloadRelease,
  importRelease,
  updateReleaseDescription,
  describeAsCopy,
  type CopiedFrom,
  type ReleaseSummary,
} from "../deploy/release.js";
import { guardedIn } from "../deploy/table.js";
import { ArchiveTooLargeError, decodeWorkspaceArchive, unwrapGzip } from "../validate/archive.js";
import { sha256Hex } from "../util/sha256.js";
import { credentialFlags, shellWord } from "./command-line.js";
import { normalisationNote } from "./name-normalisation.js";
import { EXIT_RELEASE_REFUSED, lookupRelease, readUnanswered } from "./release-common.js";

const HELP = { helpFor: { command: "release", subcommand: "transfer" } } as const;


/** How far past our tar a candidate may inflate while it can still be compared. */
const CANDIDATE_LAYER_SLACK = 1024 * 1024;

class TransferDisagreedError extends Error {
  override readonly name = "TransferDisagreedError";
  readonly exitCode = EXIT_RELEASE_REFUSED;
}

type TransferStep = "read" | "search" | "import" | "verify";

/** A seeded table as the transfer reports it: what rides along, and what is not public. */
interface SeededRow {
  name: string;
  guid: string | undefined;
  count: number | undefined;
  /** Columns marked internal or sensitive. Absent when the source's columns could not be read. */
  nonPublicColumns?: string[];
}

interface TransferExtras {
  /** The release this was copied from, as the source stores it. */
  source: OperationRelease;
  /** sha256 of the archive's tar, gzip peeled — the same for every copy of the release. */
  sha256: string;
  /** An identical release was already at the destination, and nothing was imported. */
  reused: boolean;
  /** An identical release a concurrent run left beside this one. Reported, never removed. */
  duplicateOf: { id: number; name: string };
  /** `--dry-run` only: whether the transfer is already at the destination. */
  present: "identical" | "absent" | "conflict";
  /** When the destination was searched: an `absent` answer holds as of then. */
  checkedAt: string;
  /** sha256 of what the destination holds after the import, when it differs from `sha256`. */
  destinationSha256: string;
  seededTables: SeededRow[];
  /** Whether the copy's description now records the release it was copied from (`release show` reads it as its origin). */
  copyRecorded: boolean;
}

type TransferOperation = OperationBuilder<TransferStep, TransferExtras>;


/**
 * The destination profile pinned to a workspace its own credential cannot see,
 * as the usage error a wrong source workspace gets — but with the remedy for
 * the PROFILE: the source's environment or credential file is not what is
 * wrong. Undefined when the workspace list holds the id, holds nothing, or
 * cannot be read: the failure is then its own answer.
 */
async function unreachableDestination(
  dst: ResolvedAuth,
  toProfile: string,
  args: ParsedArgs,
  rerun: string,
): Promise<UsageError | undefined> {
  const { readReachableWorkspaces, reachableLines } = await import("./workspace-binding.js");
  const all = await readReachableWorkspaces(dst, 15_000);
  if (all === undefined || all.length === 0 || all.some((w) => w.id === dst.workspaceId)) return undefined;
  const { resolveAuthFilePath, readCredentialFile, readProfile, loginCommand, profileAddCommand } = await import("../auth/store.js");
  const path = resolveAuthFilePath(args);
  const only = all.length === 1 ? all[0]!.id : undefined;
  let repin: string;
  if (dst.credentialType === "token") {
    repin = `Re-add it pinned to ${only === undefined ? "one of the workspaces below" : `workspace ${only}`}: \`${profileAddCommand(toProfile, { path, instance: dst.instance, workspaceId: only })} --force\``;
  } else {
    let origin: string | undefined;
    try {
      const file = readCredentialFile(path);
      const saved = file === null ? null : readProfile(file, toProfile, path);
      origin = saved !== null && saved.type !== "token" ? saved.auth_host : undefined;
    } catch {
      origin = undefined;
    }
    repin = `Sign it in again and choose ${only === undefined ? "one of the workspaces below" : `workspace ${only}`}: \`${loginCommand(toProfile, { path, origin }, ["--force"])}\``;
  }
  return new UsageError(
    `Workspace ${dst.workspaceId} does not exist on ${new URL(dst.instance).host} (or the \`${toProfile}\` credential ` +
      `cannot see it), and \`--to-profile ${toProfile}\` is pinned to it. Nothing was sent.\n` +
      `${repin}, then run \`${rerun}\`.\n\nWorkspaces the \`${toProfile}\` credential can reach:\n${reachableLines(all)}`,
  );
}

function sameBackend(a: ResolvedAuth, b: ResolvedAuth): boolean {
  const origin = (u: string): string => {
    try {
      return new URL(u).origin;
    } catch {
      return u.replace(/\/+$/, "");
    }
  };
  return origin(a.instance) === origin(b.instance) && a.workspaceId === b.workspaceId;
}

/**
 * The release name the archive carries, which is the name an import stores it
 * under. It lives in the archive's `workspace.json`, under the payload's
 * release metadata; an archive without it is not one the destination accepts
 * as a release at all.
 */
function decodeSourceArchive(bytes: Uint8Array): unknown {
  try {
    return decodeWorkspaceArchive(bytes);
  } catch (err) {
    throw new Error(
      `The source archive could not be read as a release archive (${(err as Error).message}). Nothing was sent.`,
    );
  }
}

function embeddedReleaseName(decoded: unknown): string {
  const release = (decoded as { payload?: { metadata?: { release?: { name?: unknown } } } } | null)?.payload?.metadata
    ?.release;
  const name = release?.name;
  if (typeof name !== "string" || name === "") {
    throw new Error(
      `The source archive carries no release name in its metadata, so the destination would not ` +
        `accept it as a release. Nothing was sent.`,
    );
  }
  return name;
}

/** `N` or `N-` plus four hex characters: every name an import of `N` can be stored under. */
function isCandidateName(name: string, embedded: string): boolean {
  if (name === embedded) return true;
  if (!name.startsWith(`${embedded}-`)) return false;
  return /^[0-9a-f]{4}$/.test(name.slice(embedded.length + 1));
}

/** Exact `N` first, then lowest id — the one order every run agrees on. */
function candidateOrder(embedded: string) {
  return (a: ReleaseSummary, b: ReleaseSummary): number => {
    const exact = Number(b.name === embedded) - Number(a.name === embedded);
    if (exact !== 0) return exact;
    return (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER);
  };
}

/**
 * The digest a transfer judges "the same release" by: sha256 of the archive's
 * tar, every gzip layer peeled.
 *
 * Not of the downloaded bytes. Measured live: the import route stores the
 * archive DECOMPRESSED, so a release cut on the server downloads as its
 * `.tar.gz` and every imported copy downloads as the bare tar — different bytes
 * and different sizes for the same release, while the tar inside is
 * byte-identical across any number of hops. `resource_size` records whatever
 * was uploaded, so it is no identity either.
 */
function contentSha256(bytes: Uint8Array): string {
  return sha256Hex(unwrapGzip(bytes));
}

/**
 * The first candidate holding the same archive content, in
 * {@link candidateOrder}. Every candidate is downloaded — there are only `N`
 * and its suffixed siblings, and no stored field identifies content. A
 * candidate whose download fails refuses the whole transfer: without its bytes
 * it cannot be told apart from ours, and importing beside what may be an
 * identical release is how a duplicate gets minted.
 *
 * A candidate is inflated under a bound tied to OUR tar, not the global one.
 * Anyone who can import on the destination can plant a small archive under a
 * candidate name that inflates without bound, and one that inflates past our
 * tar cannot hold it — so it is judged not identical without being read, and a
 * planted `N` falls through to the ordinary conflict refusal, which names it.
 */
async function findIdentical(
  dst: ResolvedAuth,
  candidates: readonly ReleaseSummary[],
  sha: string,
  tarLength: number,
): Promise<ReleaseSummary | undefined> {
  // Room for an intermediate gzip layer, which can run a little past the tar
  // it wraps when the content does not compress.
  const bound = tarLength + CANDIDATE_LAYER_SLACK;
  for (const c of candidates) {
    if (c.id === undefined) continue;
    let theirs: Uint8Array;
    try {
      theirs = await downloadRelease(dst, { workspaceId: dst.workspaceId, id: c.id });
    } catch (err) {
      throw new Error(
        `Could not download the destination's release "${c.name}" (id ${c.id}) to compare it: ` +
          `${(err as Error).message}\nNothing was imported — without its bytes it cannot be told apart from ` +
          `this one. Retry once it downloads.`,
      );
    }
    let theirSha: string;
    try {
      theirSha = sha256Hex(unwrapGzip(theirs, { maxBytes: bound }));
    } catch (err) {
      if (err instanceof ArchiveTooLargeError) continue;
      throw err;
    }
    if (theirSha === sha) return c;
  }
  return undefined;
}

/**
 * The seeded tables, with the non-public columns each carries.
 *
 * The columns are read from the RELEASE — the table schemas its archive
 * carries, matched by guid (by name when a row has none) — because that is what
 * travels. The source workspace's current tables were read here once, and a
 * release cut from an ephemeral (or a table edited since the cut) reported a
 * password column as no non-public columns at all. A table the archive carries
 * no schema for is said to be unknown (`nonPublicColumns` absent) rather than
 * clean.
 */
export function seededRows(found: ReleaseSummary, decoded: unknown): SeededRow[] {
  if (found.seededTables.length === 0) return [];
  const payload = (decoded as { payload?: { dbo?: unknown } } | null)?.payload;
  const tables = Array.isArray(payload?.dbo) ? (payload.dbo as Record<string, unknown>[]) : [];
  const byGuid = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  for (const t of tables) {
    if (t === null || typeof t !== "object" || !Array.isArray(t.schema)) continue;
    const guarded = guardedIn(t.schema);
    if (typeof t.guid === "string") byGuid.set(t.guid, guarded);
    if (typeof t.name === "string") byName.set(t.name, guarded);
  }
  return found.seededTables.map((t) => {
    const columns = (t.guid !== undefined ? byGuid.get(t.guid) : undefined) ?? byName.get(t.name);
    return {
      name: t.name,
      guid: t.guid,
      count: t.count,
      ...(columns === undefined ? {} : { nonPublicColumns: [...columns] }),
    };
  });
}

/**
 * Say which table rows ride along. Printed before the confirmation and under
 * `--yes` alike: a run that skips the prompt is exactly the one where this
 * listing is the only record of what went.
 */
function reportSeeded(rows: readonly SeededRow[]): void {
  if (rows.length === 0) return;
  warn(
    `This release carries table rows, and they go to the destination with it:`,
    "release.rows-transferred",
    rows.map((r) => {
      const count = r.count === undefined ? "" : ` (${r.count} row${r.count === 1 ? "" : "s"})`;
      const guarded =
        r.nonPublicColumns === undefined
          ? " — non-public columns could not be read"
          : r.nonPublicColumns.length === 0
            ? ""
            : ` — non-public columns: ${r.nonPublicColumns.join(", ")}`;
      return `${r.name}${count}${guarded}`;
    }),
  );
}

/**
 * `words` — a command that asks before it writes — as it runs from here,
 * acting as the destination profile: an environment credential outranks
 * `--profile` (and refuses it), so its variables are left out of that one
 * command's environment. That command carries `--yes` whenever it leaves them
 * out: its own needs-confirmation rerun is composed in a process that never saw
 * them, so it could not say to leave them out again. Otherwise `--yes` follows
 * {@link pipedYes}.
 */
async function destinationCommand(words: string, toProfile: string, args: ParsedArgs): Promise<string> {
  const { environmentCredentialVars } = await import("../auth/token.js");
  const env = environmentCredentialVars();
  const unset = env.complete && env.vars.length > 0;
  const prefix = unset ? `env ${env.vars.map((v) => `-u ${v}`).join(" ")} ` : "";
  const yes = unset ? " --yes" : pipedYes(args);
  return `${prefix}xanosdk ${words}${yes}${credentialFlags({ profile: toProfile, authFile: args.authFile })}`;
}

function identityOf(auth: ResolvedAuth, r: { id: number | undefined; name: string }): OperationRelease {
  return { instance: auth.instance, workspaceId: auth.workspaceId, id: r.id, name: r.name };
}

export async function runReleaseTransfer(args: ParsedArgs): Promise<void> {
  const name = args.positionals[0];
  if (name === undefined || name === "") {
    throw new UsageError(
      `\`xanosdk release transfer\` needs a release name. Run \`xanosdk release list${contextFlags()}\` to see them.`,
      { hintFor: HELP.helpFor },
    );
  }
  assertOneName(name, "the release name", { args, helpFor: HELP.helpFor });
  const toProfile = args.toProfile;
  if (toProfile === undefined) {
    throw new UsageError(
      `\`xanosdk release transfer\` needs a destination: \`--to-profile <name>\`, a stored credential ` +
        `profile bound to the workspace that should receive the release. \`xanosdk profile list\` shows them.`,
      { hintFor: HELP.helpFor },
    );
  }

  // A near miss's printed transfer is this run on the corrected name: the
  // run's own read-only and output flags kept, never one that writes more.
  const transferCommand = (release: string, profile: string): string =>
    `xanosdk release transfer ${shellWord(release)} --to-profile ${shellWord(profile)}` +
    `${args.dryRun === true ? " --dry-run" : ""}${args.json === true ? " --json" : ""}${credentialFlags(args)}`;
  // This transfer to run again once a remedy is applied: it asks before it
  // imports, so it carries this run's `--yes` (or an off-terminal run's).
  const again = (): string => `${transferCommand(name, toProfile)}${args.dryRun === true ? "" : pipedYes(args)}`;

  const src = await getAccessToken(args);
  const dst = await resolveNamedProfile(toProfile, args, "--to-profile").catch(async (err: unknown) => {
    if (!(err instanceof ProfileNotFoundError)) throw err;
    const { readCredentialFile, profileNames, resolveAuthFilePath } = await import("../auth/store.js");
    const { suggestAll } = await import("../util/suggest.js");
    const file = readCredentialFile(resolveAuthFilePath(args));
    const near = suggestAll(toProfile, file === null ? [] : profileNames(file));
    if (near.length === 0) throw err;
    throw new ProfileNotFoundError(
      `${err.message}${near.map((n) => `\nDid you mean "${safeText(n)}"? \`${transferCommand(name, n)}\``).join("")}`,
    );
  });
  // Before any read: nothing either side could answer changes this.
  if (sameBackend(src, dst)) {
    throw new UsageError(
      `\`--to-profile ${toProfile}\` is bound to the same instance and workspace the release is read from ` +
        `(${describeWriteTarget({ base: dst.instance, workspaceId: dst.workspaceId })}). A transfer onto ` +
        `itself can only store a duplicate. Name a profile bound to another workspace.`,
      // A runtime refusal: the command's shape was fine, so a pointer, not the block.
      { hintFor: HELP.helpFor },
    );
  }

  const dryRun = args.dryRun === true;
  const destination: WriteTarget = { base: dst.instance, workspaceId: dst.workspaceId, label: `profile "${toProfile}"` };
  const source: WriteTarget = { base: src.instance, workspaceId: src.workspaceId };

  // Both sides, before anything is read — the destination is the one that is
  // written, and a wrong profile is the mistake this line exists to catch.
  step(`${dryRun ? "Checking" : "Transferring"} release "${name}"`);
  detail(`from ${describeWriteTarget(source)}`);
  discloseWriteTarget(destination);

  const op: TransferOperation = createOperation<TransferStep, TransferExtras>({
    operation: "release transfer",
    // The one destination shape: a workspace is `{ instance, workspaceId, kind }`.
    // The profile's name is the progress line's label, not a machine field.
    destination: { base: dst.instance, workspaceId: dst.workspaceId, kind: "workspace" },
    // The embedded name replaces this once the archive has been read.
    release: identityOf(dst, { id: undefined, name }),
    branch: null,
    steps: ["read", "search", "import", "verify"],
  });

  // The one read that settles every unknown this command can end on: the same
  // transfer, searching only. It re-hashes whatever the destination holds.
  const resolveWith =
    `xanosdk release transfer ${shellWord(name)} --to-profile ${shellWord(toProfile)} --dry-run` +
    `${credentialFlags(args)} --json`;

  const machine = isMachineOutput(args);
  // Ends that are answers, not failures: a dry run that found nothing, and a
  // declined confirmation. Both leave the result `no` and exit 0.
  let answeredNo = false;
  try {
    await runOperation(op, { machine, resolveWith, what: `the import of "${name}"` }, async () => {
      op.begin("read");
      const found = await lookupRelease(src, name);
      if (found === null) {
        // With the near names the source holds, each as its own transfer.
        const { releaseNames } = await import("./source-resolve.js");
        const { suggestAll } = await import("../util/suggest.js");
        const near = suggestAll(name, (await releaseNames(src).catch(() => [])).filter((n) => n !== name));
        const meant = near.map(
          (n) => `\nDid you mean "${safeText(n)}"${normalisationNote(name, n)}? \`${transferCommand(n, toProfile)}\``,
        );
        throw new SourceError(
          `No release named "${name}". \`xanosdk release list${contextFlags()}\` shows the ones that exist.${meant.join("")}`,
          "gone",
          "release",
          near[0],
          near.length > 1 ? near : undefined,
        );
      }
      if (found.id === undefined) {
        throw new Error(`Release "${name}" carries no id, so it cannot be downloaded. Nothing was sent.`);
      }
      op.set("source", identityOf(src, { id: found.id, name: found.name }));

      const bytes = await downloadRelease(src, { workspaceId: src.workspaceId, id: found.id });
      // Peeled once: the digest, the embedded name and the seeded tables'
      // columns are all read off the tar.
      const tar = unwrapGzip(bytes);
      const decoded = decodeSourceArchive(tar);
      const seeded = seededRows(found, decoded);
      op.set("seededTables", seeded);
      reportSeeded(seeded);

      const sha = sha256Hex(tar);
      op.set("sha256", sha);
      const embedded = embeddedReleaseName(decoded);
      op.setRelease(identityOf(dst, { id: undefined, name: embedded }));
      if (embedded !== found.name) {
        detail(`Stored at the source as "${found.name}"; the archive names itself "${embedded}".`);
      }
      op.finish("read");

      op.begin("search");
      let rows: ReleaseSummary[];
      try {
        rows = await listReleases(dst, { workspaceId: dst.workspaceId });
      } catch (err) {
        // No answer is not a credential problem: exit 8, with this run as the
        // rerun, as the source side's lookup says it (E2E pass 22).
        const unanswered = readUnanswered(
          "release",
          `search the destination (${describeWriteTarget(destination)}) for release "${embedded}"`,
          "a refusal",
          err,
        );
        if (unanswered !== err) throw unanswered;
        // A profile pinned to a workspace its credential cannot see: the profile is what to fix.
        const unreachable = await unreachableDestination(dst, toProfile, args, again());
        if (unreachable !== undefined) throw unreachable;
        // An answer that refused the list: the credential's. Its head in the
        // sentence, any line under it (a binding's explanation) after — never a
        // multi-line message inside parentheses.
        const [head = "", ...rest] = (err instanceof Error ? err.message : String(err)).split("\n");
        throw new Error(
          [
            `The \`${toProfile}\` credential cannot list releases on ${describeWriteTarget(destination)}: ` +
              `${head.trim().replace(/[.:]$/, "")}. A transfer never imports without searching first. Nothing was sent.`,
            ...rest,
          ].join("\n"),
        );
      }
      const candidates = rows.filter((r) => isCandidateName(r.name, embedded)).sort(candidateOrder(embedded));
      const match = await findIdentical(dst, candidates, sha, tar.length);
      const checkedAt = new Date().toISOString();
      op.set("checkedAt", checkedAt);

      if (match !== undefined) {
        op.setRelease(identityOf(dst, match));
        op.set("reused", true);
        if (dryRun) op.set("present", "identical");
        op.finish("search");
        op.finish("import", "skipped");
        op.finish("verify");
        // On stderr, so a piped run says it too: the document on stdout carries the rest.
        success(
          `${dryRun ? "Already at" : "Reused"} the destination: "${match.name}" (id ${match.id}) holds the same bytes`,
        );
        detail(`sha256 ${sha}`);
        // An earlier transfer whose copy record failed left this one bare; the
        // rerun its warning printed lands here, so this is where it is repaired.
        if (match.id !== undefined && unrecordedCopy(match)) {
          if (dryRun) detail("It does not record which release it was copied from; a transfer would record it.");
          else await recordCopy(op, dst, { id: match.id, name: match.name }, found, src, again());
        }
        return;
      }

      const holder = candidates.find((c) => c.name === embedded);
      if (holder !== undefined) {
        if (dryRun) op.set("present", "conflict");
        op.finish("search", "no");
        // The same code and `details.conflictsWith` a `release create` over a
        // taken name gives: one refusal, one shape.
        throw new CliError(
          "SDK_RELEASE_NAME_TAKEN",
          `The destination already holds a different release named "${embedded}"` +
            `${holder.id === undefined ? "" : ` (id ${holder.id})`}, and no release there holds these bytes. ` +
            `Releases are not replaced — nothing was imported.\n` +
            `To replace it, delete it there with \`${await destinationCommand(`release delete ${shellWord(holder.name)}`, toProfile, args)}\`, ` +
            `then run \`${again()}\` again.`,
          { exitCode: EXIT_RELEASE_REFUSED, details: { conflictsWith: { id: holder.id, name: holder.name } } },
        );
      }

      op.finish("search");
      if (dryRun) {
        op.set("present", "absent");
        op.finish("import", "no");
        answeredNo = true;
        info(`Not at the destination as of ${checkedAt}. A transfer would import it as "${embedded}".`);
        return;
      }

      if (args.yes !== true) {
        const { rerun, note } = yesRerun(args, `release transfer ${shellWord(found.name)}`);
        const ok = await confirm(`Import release "${embedded}" into ${describeWriteTarget(destination)}?`, {
          flag: "--yes",
          refusal: { details: { verb: "transfer", imported: false, declined: false }, rerun, note },
        });
        if (!ok) {
          warn("Transfer cancelled — nothing was imported.", "release.transfer-cancelled");
          answeredNo = true;
          return;
        }
      }

      op.set("reused", false);
      op.begin("import");
      op.sending();
      const { id } = await importRelease(dst, { workspaceId: dst.workspaceId, archive: bytes }).catch(async (err: unknown) => {
        // Gone since the search: no workspace there means nothing was stored.
        throw (await unreachableDestination(dst, toProfile, args, again())) ?? err;
      });
      op.finish("import");
      op.setRelease(identityOf(dst, { id, name: embedded }));

      const stored = await verify(op, { dst, id, embedded, sha, tarLength: tar.length, toProfile, config: args.authFile, yes: pipedYes(args) });
      await recordCopy(op, dst, { id, name: stored }, found, src, again());
    });
  } catch (err) {
    if (answeredNo) return;
    throw err;
  }
}

/**
 * Read the import back by the id it returned, re-download it, re-hash it.
 *
 * A read that fails here leaves the transfer `unknown`, not `no`: the import
 * answered, so something is there, and whether it is these bytes is exactly the
 * question the dry run answers.
 */
async function verify(
  op: TransferOperation,
  ctx: {
    dst: ResolvedAuth;
    id: number;
    embedded: string;
    sha: string;
    /** Our tar's length, which bounds how far a candidate is read. */
    tarLength: number;
    toProfile: string;
    /** The credential file the run named, which holds the destination profile too. */
    config: string | undefined;
    /** ` --yes` where the delete pasted from this run would otherwise refuse ({@link pipedYes}). */
    yes: string;
  },
): Promise<string> {
  const { dst, id, embedded, sha } = ctx;
  op.begin("verify");
  let landed: ReleaseSummary;
  let landedBytes: Uint8Array;
  try {
    const got = await getRelease(dst, { workspaceId: dst.workspaceId, id });
    if (got === null) {
      throw new Error(`The import answered with id ${id}, and the destination holds no release by that id.`);
    }
    landed = got;
    landedBytes = await downloadRelease(dst, { workspaceId: dst.workspaceId, id });
  } catch (err) {
    op.finish("verify", "unknown");
    throw err;
  }
  const stored = landed.name !== "" ? landed.name : embedded;
  op.setRelease(identityOf(dst, { id, name: stored }));

  const landedSha = contentSha256(landedBytes);
  if (landedSha !== sha) {
    // The DESTINATION's profile, from the same credential file the run used.
    const removeWith =
      `xanosdk release delete ${shellWord(stored)}${ctx.yes} --profile ${shellWord(ctx.toProfile)}` +
      `${ctx.config === undefined ? "" : ` --config ${shellWord(ctx.config)}`}`;
    op.set("destinationSha256", landedSha);
    op.setResidue({ id, name: stored, removeWith });
    op.finish("verify", "no");
    throw new TransferDisagreedError(
      `Imported "${stored}" (id ${id}), but what the destination holds does not hash to what was sent ` +
        `(sent ${sha}, holds ${landedSha}).\nIt has been kept, not removed — it is the evidence. ` +
        `Remove it with \`${removeWith}\`.`,
    );
  }

  const duplicate = stored === embedded ? undefined : await concurrentDuplicate(dst, { id, embedded, sha, tarLength: ctx.tarLength });
  if (duplicate !== undefined) op.set("duplicateOf", duplicate);
  op.finish("verify");

  // On stderr, so a piped run says it too: the document on stdout carries the rest.
  success(`Transferred "${stored}" (id ${id})`);
  detail(`sha256 ${sha} — verified on the destination`);
  if (stored !== embedded) {
    warn(`The destination stored it as "${stored}": "${embedded}" was taken by the time it landed.`, "release.name-stored");
  }
  if (duplicate !== undefined) {
    detail(
      `"${duplicate.name}" (id ${duplicate.id}) holds the same release — a concurrent transfer's. Neither was removed.`,
    );
  }
  return stored;
}

/**
 * Write onto the copy's description the release it was copied from, and where
 * that one was cut.
 *
 * The import keeps no description and tags the copy with a branch, so without
 * this the copy reads as a cut from that branch — and a landing's
 * password-hash warning names the wrong place the rows were hashed. Best
 * effort: the copy is already verified, so a refused or failed update is
 * warned about, not raised.
 */
async function recordCopy(
  op: TransferOperation,
  dst: ResolvedAuth,
  copy: { id: number; name: string },
  source: ReleaseSummary,
  src: ResolvedAuth,
  /** This transfer, which records it on the copy when run again. */
  rerun: string,
): Promise<void> {
  const cut =
    source.copiedFrom?.cut ??
    source.recordedOrigin ??
    (typeof source.branch === "string" && source.branch !== "" ? { type: "branch", name: source.branch } : undefined);
  const copied: CopiedFrom = {
    source: { host: new URL(src.instance).host, workspaceId: src.workspaceId, release: source.name },
    ...(cut === undefined ? {} : { cut }),
  };
  const description = describeAsCopy(source.description, copied);
  try {
    const updated = await updateReleaseDescription(dst, { workspaceId: dst.workspaceId, ...copy, description });
    if (updated.copiedFrom === undefined) {
      throw new Error("the update answered without the description it was sent");
    }
    op.set("copyRecorded", true);
  } catch (err) {
    op.set("copyRecorded", false);
    const cause = ((err as Error).message.split("\n")[0] ?? "").trim().replace(/[.:;]$/, "");
    warn(
      `Transferred, but recording on "${copy.name}" which release it was copied from failed (${cause}). ` +
        `The copy is intact; until it is recorded, \`release show\` at the destination reports its origin as the branch the import tagged it with.`,
      "release.copy-unrecorded",
      [`Run \`${rerun}\` again to record it.`],
    );
  }
}

/**
 * A destination release as an import leaves it before its copy record is
 * written: no description, no recorded origin, no copy marker. A release with
 * any of those says where it came from already and is left as it is.
 */
function unrecordedCopy(r: ReleaseSummary): boolean {
  return r.copiedFrom === undefined && r.recordedOrigin === undefined && (r.description ?? "") === "";
}

/**
 * An identical release beside the one just imported: what a concurrent run of
 * the same transfer leaves. Only looked for when the import was stored under a
 * suffix, since that says something took `N` between the search and the import.
 * Best effort — the transfer itself is already verified.
 */
async function concurrentDuplicate(
  dst: ResolvedAuth,
  ctx: { id: number; embedded: string; sha: string; tarLength: number },
): Promise<{ id: number; name: string } | undefined> {
  try {
    const rows = await listReleases(dst, { workspaceId: dst.workspaceId });
    const others = rows
      .filter((r) => r.id !== ctx.id && isCandidateName(r.name, ctx.embedded))
      .sort(candidateOrder(ctx.embedded));
    const twin = await findIdentical(dst, others, ctx.sha, ctx.tarLength);
    return twin?.id === undefined ? undefined : { id: twin.id, name: twin.name };
  } catch {
    detail(`Could not check the destination for a concurrent copy of "${ctx.embedded}".`);
    return undefined;
  }
}
